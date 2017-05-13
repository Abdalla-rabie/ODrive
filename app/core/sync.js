const assert = require('assert');
const path = require("path");
const fs = require("fs-extra");
const mkdirp = require("mkdirp-promise");
const delay = require("delay");
const unique = require("array-unique");
const deepEqual = require("deep-equal");
const globals = require('../../config/globals');

let fileInfoFields = "id, name, mimeType, md5Checksum, size, modifiedTime, parents, trashed";
let listFilesFields = `nextPageToken, files(${fileInfoFields})`;
let changeInfoFields = `time, removed, fileId, file(${fileInfoFields})`;
let changesListFields = `nextPageToken, newStartPageToken, changes(${changeInfoFields})`;

class Sync {
  constructor(account) {
    this.account = account;
    this.fileInfo = {};
    this.rootId = null;
    this.synced = false;
    this.changeToken = null;
    this.loaded = false;
    this.watchingChanges = false;

    /* Check if already in memory */
    this.load();
  }

  get running() {
    return "id" in this;
  }

  get drive() {
    return this.account.drive;
  }

  get folder() {
    return this.account.folder;
  }

  async start(notifyCallback) {
    await this.finishLoading();

    assert(!this.syncing, "Sync already in progress");
    this.syncing = true;

    try {
      let notify = notifyCallback || (() => {});

      let rootInfo = await this.getFileInfo("root");
      this.rootId = rootInfo.id;

      notify("Watching changes in the remote folder...");
      await this.startWatchingChanges();

      notify("Getting files info...");

      let files = await this.downloadFolderStructure("root");

      let counter = 0;
      let ignored = 0;

      for (let file of files) {
        if (this.shouldIgnoreFile(file)) {
          /* Not a stored file, no need...
            Will handle google docs later.
          */
          ignored += 1;

          notify(`${counter} files downloaded, ${ignored} files ignored...`);
          continue;
        }

        console.log("Downloading ", file);
        counter +=1;
        await this.downloadFile(file);
        notify(`${counter} files downloaded, ${ignored} files ignored...`);
      }

      notify(`All done! ${counter} files downloaded and ${ignored} ignored.`);
      this.syncing = false;
      this.synced = true;

      await this.save();
    } catch (err) {
      this.syncing = false;
      throw err;
    }
  }

  async startWatchingChanges() {
    await this.finishLoading();

    if (this.changeToken) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.drive.changes.getStartPageToken({}, (err, res) => {
        if (err) {
          return reject(err);
        }
        console.log("Start token for watching changes: ", res.startPageToken);

        /* Make sure a parallel execution didn't get another token first. Once we've got a token, we stick with it */
        if (!this.changeToken) {
          this.changeToken = res.startPageToken;
        }

        resolve(res);
      });
    });
  }

  /* Continuously watch for new changes and apply them */
  async watchChanges() {
    await this.finishLoading();

    /* Make sure only one instance of this function is running. Love that nodejs is asynchronous but runs on one thread, atomicity is guaranteed */
    if (this.watchingChanges) {
      return;
    }
    this.watchingChanges = true;

    try {
      if (!this.changeToken) {
        console.error(new Error("Error in application flow, no valid change token"));
        await this.startWatchingChanges();
      }

      while (1) {
        /* Don't handle changes at the same time as syncing... */
        if (!this.syncing && this.synced) {
          await this.handleNewChanges();
        }
        await delay(8000);
      }
    } catch (err) {
      this.watchingChanges = false;
      throw err;
    }
  }

  async handleNewChanges() {
    let changes = await this.getNewChanges();

    for (let change of changes) {
      await this.handleChange(change);
    }

    /* Only save at the end. Because we updated local change token in `this.getNewChanges`, so if it was saved prematurely and an error occurred, next load would skip over those changes. */

    if (changes.length > 0) {
      await this.save();
    }
  }

  async handleChange(change) {
    /* Todo */
    console.log("Change", change);

    /* Deleted file */
    if (change.removed || change.file.trashed) {
      console.log("deleted file");
      await this.removeFileLocally(change.fileId);
      return;
    }

    console.log(change.fileId, this.fileInfo[change.fileId]);

    /* New file */
    if (!(change.fileId in this.fileInfo)) {
      console.log("new file");
      await this.addFileLocally(change.file);
      return;
    }

    /* Changed file */
    let newInfo = change.file;
    let oldInfo = this.fileInfo[change.fileId];
    this.storeFileInfo(newInfo);

    if (this.noChange(newInfo, oldInfo)) {
      console.log("Same main info, ignoring");
      /* Nothing happened */
      return;
    }

    if (newInfo.md5Checksum != oldInfo.md5Checksum) {
      console.log("Different checksum, redownloading")
      /* Content changed, may as well delete it and redownload it */
      await this.removeFileLocally(oldInfo.id);
      await this.addFileLocally(newInfo);

      return;
    }

    /* Changed Paths */
    let oldPaths = await this.getPaths(oldInfo);
    if (oldPaths.length == 0) {
      console.log("Wasn't in main folder, downloading");
      await this.addFileLocally(newInfo);
      return;
    }

    if (this.shouldIgnoreFile(newInfo)) {
      console.log("Ignoring file, content worthless");
      return;
    }
    let newPaths = await this.getPaths(newInfo);

    console.log("Moving file");
    await this.changePaths(oldPaths, newPaths);
  }

  noChange(oldInfo, newInfo) {
    if (oldInfo.modifiedTime != newInfo.modifiedTime) {
      return false;
    }
    if (oldInfo.name != newInfo.name) {
      return false;
    }
    if (!deepEqual(oldInfo.parents, newInfo.parents)) {
      return false;
    }
    return true;
  }

  async addFileLocally(fileInfo) {
    await this.storeFileInfo(fileInfo);
    await this.downloadFile(fileInfo);
  }

  async removeFileLocally(fileId) {
    if (!(fileId in this.fileInfo)) {
      console.error("Impossible to remove unknown file id ", fileId);
      return;
    }

    let fileInfo = this.fileInfo[fileId];
    let paths = await this.getPaths(fileInfo);

    delete this.fileInfo[fileId];
    for (let path of paths) {
      await fs.remove(path);
    }
  }

  async getNewChanges() {
    let changes = [];
    let pageToken = this.changeToken;

    while (pageToken) {
      let result = await new Promise((resolve, reject) => {
        this.drive.changes.list({
          corpora: "user",
          spaces: "drive",
          pageSize: 1000,
          pageToken,
          restrictToMyDrive: true,
          fields: changesListFields
        }, (err, res) => {
          if (err) {
            return reject(err);
          }
          resolve(res);
        });
      });

      pageToken = result.nextPageToken;
      changes = changes.concat(result.changes);

      if (result.newStartPageToken) {
        this.changeToken = result.newStartPageToken;
      }
    }

    return changes;
  }

  async downloadFolderStructure(folder) {
    await this.finishLoading();

    /* Try avoiding triggering antispam filters on Google's side, given the quantity of data */
    await delay(100);

    console.log("Downloading folder structure for ", folder);
    let files = await this.folderContents(folder);

    let res = [].concat(files);//clone to a different array
    for (let file of files) {
      if (file.mimeType.includes("folder")) {
        res = res.concat(await this.downloadFolderStructure(file.id));
      }
    }

    return res;
  }

  async folderContents(folder) {
    await this.finishLoading();

    let q = folder ? `trashed = false and "${folder}" in parents` : null;

    let {nextPageToken, files} = await this.filesListChunk({folder,q});

    console.log(files, nextPageToken);
    console.log("(Chunk 1)");

    let counter = 1;
    while(nextPageToken) {
      /* Try avoiding triggering antispam filters on Google's side, given the quantity of data */
      await delay(500);

      let data = await this.filesListChunk({pageToken: nextPageToken, q});
      nextPageToken = data.nextPageToken;
      files = files.concat(data.files);

      counter += 1;
      console.log(data);
      console.log(`(Chunk ${counter})`, nextPageToken);
    }

    console.log("Files list done!");

    return files;
  }

  async filesListChunk(arg) {
    await this.finishLoading();

    let {pageToken, q} = arg;

    let result = await new Promise((resolve, reject) => {
      q = q || 'trashed = false'
      let args = {
        fields: listFilesFields,
        corpora: "user",
        spaces: "drive",
        pageSize: 1000,
        q
      };

      if (pageToken) {
        args.pageToken = pageToken;
      }
      console.log("Getting files chunk", args);
      this.drive.files.list(args, (err, result) => {
        if (err) {
          return reject(err);
        }

        resolve(result);
      });
    });

    return result;
  }

  async getPaths(fileInfo) {
    console.log('Get path', fileInfo.name);
    if (fileInfo.id == this.rootId) {
      return [this.folder];
    }
    if (!fileInfo.parents) {
      console.log("File out of the main folder structure", fileInfo);
      return [];
    }

    let ret = [];

    for (let parent of fileInfo.parents) {
      let parentInfo = await this.getFileInfo(parent);
      for (let parentPath of await this.getPaths(parentInfo)) {
        ret.push(path.join(parentPath, fileInfo.name));
      }
    }

    return ret;
  }

  /* Rename / move files appropriately to new destinations */
  async changePaths(oldPaths, newPaths) {
    if (oldPaths.length == 0) {
      console.log("Can't change path, past path is empty");
      return;
    }

    let removedPaths = [];
    let addedPaths = [];

    for (let path of oldPaths) {
      if (!newPaths.includes(path)) {
        removedPaths.push(path);
      }
    }

    for (let path of newPaths) {
      if (!oldPaths.includes(path)) {
        addedPaths.push(path);
      }
    }

    for (let _path of addedPaths) {
      await mkdirp(path.dirname(_path));
    }

    for (let i = 0; i < removedPaths.length; i += 1) {
      if (i < addedPaths.length) {
        await fs.rename(removedPaths[i], addedPaths[i]);
        continue;
      }

      await fs.remove(removedPaths[i]);
    }

    for (let i = removedPaths.length; i < addedPaths.length; i += 1) {
      await fs.copy(newPaths[0], addedPaths[i]);
    }
  }

  isFolder(fileInfo) {
    return fileInfo.mimeType.includes("folder");
  }

  shouldIgnoreFile(fileInfo) {
    if (fileInfo.id == this.rootId) {
      return true;
    }
    if (this.isFolder(fileInfo)) {
      return false;
    }
    return !("size" in fileInfo);
  }

  /* Gets file info from fileId.

    If the file info is not present in cache or if forceUpdate is true,
    it seeks the information remotely and updates the cache as well. */
  async getFileInfo(fileId, forceUpdate) {
    await this.finishLoading();

    console.log("Getting individual filed info: ", fileId);
    if (!forceUpdate && (fileId in this.fileInfo)) {
      return this.fileInfo[fileId];
    }

    let fileInfo = await new Promise((resolve, reject) => {
      this.drive.files.get({fileId, fields: fileInfoFields}, (err, result) => {
        if (err) {
          return reject(err);
        }
        resolve(result);
      });
    });

    return this.storeFileInfo(fileInfo);
  }

  async storeFileInfo(info) {
    return this.fileInfo[info.id] = info;
  }

  async downloadFile(fileInfo) {
    console.log("Downlading file", fileInfo.name);
    if (this.shouldIgnoreFile(fileInfo)) {
      console.log("Ignoring file");
      return;
    }
    if (this.isFolder(fileInfo)) {
      console.log("Doing nothing, it's a folder");
      return;
    }
    await this.finishLoading();

    let savePaths = await this.getPaths(fileInfo);

    if (savePaths.length == 0) {
      return;
    }
    let savePath = savePaths.splice(0, 1)[0];

    /* Create the folder for the file first */
    await mkdirp(path.dirname(savePath));

    var dest = fs.createWriteStream(savePath);

    await new Promise((resolve, reject) => {
      this.drive.files.get({fileId: fileInfo.id, alt: "media"})
        .on('end', () => resolve())
        .on('error', err => reject(err))
        .pipe(dest);
    });

    for (let otherPath of savePaths) {
      await fs.copy(savePath, otherPath);
    }
  }

  async finishLoading() {
    while (!this.loaded) {
      await delay(20);
    }
  }

  /* Load in NeDB */
  async load() {
    console.log("Loading sync object");
    let obj = await globals.db.findOne({type: "sync", accountId: this.account.id});

    if (obj) {
      this.changeToken = obj.changeToken;
      this.fileInfo = obj.fileInfo;
      this.synced = obj.synced;
      this.rootId = obj.rootId;
      this.id = obj._id;
    } else {
      console.log("Nothing to load");
    }

    this.loaded = true;

    console.log("Loaded sync object! ");
    if (obj && obj.synced) {
      this.watchChanges();
    }
  }

  /* Save in NeDB, overwriting previous entry */
  async save() {
    console.log("Saving sync object");
    await this.finishLoading();

    if (!this.id) {
      //Create new object
      let obj = await globals.db.insert({type: "sync", accountId: this.account.id});
      this.id = obj._id;
    }

    /* Save object */
    let saveObject = {
      type: "sync",
      accountId: this.account.id,
      changeToken: this.changeToken,
      fileInfo: this.fileInfo,
      rootId: this.rootId,
      synced: this.synced,
      _id: this.id
    };

    await globals.db.update({_id: this.id}, saveObject, {});
    console.log("Saved new synchronization changes!");

    this.watchChanges();
  }
}

module.exports = Sync;
