/* Express stuff */
const express = require('express');
const bodyParser = require('body-parser');

/* Local stuff */
const router = require('./routes/index');


var app = express();

const port = process.env.port || 16409;

app.set('view engine', 'ejs'); 

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true}));

for (let middleware of require("./core/middlewares")) {
  app.use(middleware);
}

app.use("/", express.static(__dirname + '../public'));
app.use("/", router);

async function listen() {
  try {
    let promise = new Promise(resolve => {
      app.listen(port, 'localhost', () => {resolve();});
    });

    await promise; 

    console.log("app started on port", port);
  } catch(err) {
    console.log(err);
  }
}

listen();

module.exports = {
  port
};