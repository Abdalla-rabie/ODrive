const EventEmitter = require('events');
const chokidar = require("chokidar");

class LocalWatcher extends EventEmitter {
  constructor(syncObject) {
    super();

    this.sync = syncObject;

    this.ready = false;
    this.cache = {};
    this.startWatching();
  }

  get folder() {
    return this.sync.folder;
  }

  startWatching() {
    this.watcher = chokidar.watch(this.folder, {
      //ignored: /(^|[\/\\])\../,
      persistent: true
    });

    let log = console.log.bind(console);
    this.watcher.on('ready', () => {
      this.ready = true;
      log('Initial scan complete. Ready for changes');
    });

    this.watcher.on('add', path => this.queue(path, 'add'))
      .on('change', (path, stats) => this.queue(path, 'change', stats))
      .on('unlink', path => this.queue(path, 'unlink'))
      .on('addDir', path => this.queue(path, 'addDir'))
      .on('unlinkDir', path => this.queue(path, 'unlinkDir'))
      .on('error', error => log(`Watcher error: ${error}`))
      .on('raw', (event, path, details) => {
        log('Raw event info:', event, path, details);
      });
  }

  queue(path, event, stats) {
    console.log(path, event, stats);

    if (!this.ready) {
      return;
    }

    this.addCache(path, event);
  }

  /* The whole caching system is to ensure a file has stopped being modified before processing the associated changes */
  createCache(path) {
    this.cache[path] = {
      timer: 0,
      events: []
    };
  }

  addCache(path, event) {
    if (! ("path" in this.cache)) {
      this.createCache(path);
    }

    let cache = this.cache[path];
    clearTimeout(cache.timer);
    cache.events.push(event);
    cache.timer = setTimeout(() => this.analyzeCache(path), 1000);
  }

  analyzeCache(path) {
    let cache = this.cache[path];

    /* Ignore is when the main process modifies the file and so doesn't want to be notified of recent changes to it */
    if (!cache || cache.events.includes("ignore")) {
      return this.clearCache(path);
    }

    let events = cache.events;

    /* Get last important event */
    let lastIndex = Math.max(events.lastIndexOf('unlink'), events.lastIndexOf('unlinkDir'), events.lastIndexOf('add'), events.lastIndexOf('addDir'));
    if (lastIndex != -1) {
      this.emit(events[lastIndex], path);
    } else {
      this.emit(events.pop(), path);
    }

    this.clearCache(path);
  }

  ignore(path) {
    this.addCache(path, "ignore");
  }
}

module.exports = LocalWatcher;
