/**
 * React Starter Kit (https://www.reactstarterkit.com/)
 *
 * Copyright © 2014-present Kriasoft, LLC. All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.txt file in the root directory of this source tree.
 */

import path from 'path';
import express from 'express';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';
import expressJwt, {UnauthorizedError as Jwt401Error} from 'express-jwt';
import expressGraphQL from 'express-graphql';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import axios from 'axios';
import React from 'react';
import ReactDOM from 'react-dom/server';
import PrettyError from 'pretty-error';
import App from './components/App';
import Html from './components/Html';
import {ErrorPageWithoutStyle} from './routes/error/ErrorPage';
import errorPageStyle from './routes/error/ErrorPage.css';
import createFetch from './createFetch';
import passport from './passport';
import router from './router';
import models from './data/models';
import schema from './data/schema';
import assets from './assets.json'; // eslint-disable-line import/no-unresolved
import config from './config/server';
import Log, { reqHandleErr, jsonMsg } from './utils/log';
import compression from 'compression';


global.axios = axios;

// https
const fs = require('fs');
const https = require('https');

const privateKey = fs.readFileSync(
  path.join(__dirname, '../public/ryans-key.pem'),
  'utf8',
);
const certificate = fs.readFileSync(
  path.join(__dirname, '../public/ryans-cert.pem'),
  'utf8',
);
const credentials = {key: privateKey, cert: certificate};

const app = express();
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;
const needCluster = process.env.CLUSTER || false;

//
// Tell any CSS tooling (such as Material UI) to use all vendor prefixes if the
// user agent is not known.
// -----------------------------------------------------------------------------
global.navigator = global.navigator || {};
global.navigator.userAgent = global.navigator.userAgent || 'all';

//
// Register Node.js middleware
// -----------------------------------------------------------------------------
app.use(compression());
app.use(express.static(path.resolve(__dirname, 'public')));
app.use(cookieParser());
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

//
// Authentication
// -----------------------------------------------------------------------------
app.use(
  expressJwt({
    secret: config.auth.jwt.secret,
    credentialsRequired: false,
    getToken: req => req.cookies.id_token,
  }),
);
// Error handler for express-jwt
app.use((err, req, res, next) => {
  // eslint-disable-line no-unused-vars
  if (err instanceof Jwt401Error) {
    console.error('[express-jwt-error]', req.cookies.id_token);
    // `clearCookie`, otherwise user can't use web-app until cookie expires
    res.clearCookie('id_token');
  }
  next(err);
});

app.use(passport.initialize());

if (__DEV__) {
  app.enable('trust proxy');
}
app.get(
  '/login/facebook',
  passport.authenticate('facebook', {
    scope: ['email', 'user_location'],
    session: false,
  }),
);
app.get(
  '/login/facebook/return',
  passport.authenticate('facebook', {
    failureRedirect: '/login',
    session: false,
  }),
  (req, res) => {
    const expiresIn = 60 * 60 * 24 * 180; // 180 days
    const token = jwt.sign(req.user, config.auth.jwt.secret, {expiresIn});
    res.cookie('id_token', token, {maxAge: 1000 * expiresIn, httpOnly: true});
    res.redirect('/');
  },
);

//
// Register API middleware
// -----------------------------------------------------------------------------
app.use(
  '/graphql',
  expressGraphQL(req => ({
    schema,
    graphiql: __DEV__,
    rootValue: {request: req},
    pretty: __DEV__,
  })),
);

//
// Register server-side rendering middleware
// -----------------------------------------------------------------------------
app.get('*', async (req, res, next) => {
  try {

    Log.info(jsonMsg(req.headers['user-agent']));

    const userAgent = req.headers['user-agent'].toLowerCase();
    const agentID = userAgent.match(/(iphone|ipod|ipad|android)/);
    const isMobile = agentID ? true : false;

    const css = new Set();
    // Global (context) variables that can be easily accessed from any React component
    // https://facebook.github.io/react/docs/context.html
    const context = {
      // Enables critical path CSS rendering
      // https://github.com/kriasoft/isomorphic-style-loader
      insertCss: (...styles) => {
        // eslint-disable-next-line no-underscore-dangle
        styles.forEach(style => css.add(style._getCss()));
      },
      // Universal HTTP client
      axios,
      isMobile,
      fetch: createFetch(fetch, {
        baseUrl: config.api.serverUrl,
        cookie: req.headers.cookie,
      }),
    };

    let route = {
      component: React.createElement('div', { className: 'holder' }),
    };

    try {
      route = await router.resolve({
        ...context,
        pathname: req.path,
        query: req.query,
      });
    } catch (err) {
      Log.error(reqHandleErr(err, req, '服务端 router.resolve 出错'));
    }

    if (route && route.redirect) {
      res.redirect(route.status || 302, route.redirect);
      return;
    }

    const data = {...route};
    data.children = ReactDOM.renderToString(
      <App context={context}>{route && route.component}</App>,
    );
    data.styles = [{id: 'css', cssText: [...css].join('')}];
    data.scripts = [assets.vendor.js];
    if (route && route.chunks) {
      data.scripts.push(...route.chunks.map(chunk => assets[chunk].js));
    }
    data.scripts.push(assets.client.js);
    data.app = {
      apiUrl: config.api.clientUrl,
      isMobile,
    };

    const html = ReactDOM.renderToStaticMarkup(<Html {...data} />);
    res.status(route && route.status || 200);
    res.send(`<!doctype html>${html}`);
  } catch (err) {
    Log.error(reqHandleErr(err, req, '服务端出错'));
    next(err);
  }
});

app.post('/errorLog/record', (req, res) => {
  const defaultLogLevel = 'warn';
  let logLevel = req.body.log || defaultLogLevel;

  if (!Log[logLevel]) {
    logLevel = defaultLogLevel;
  }

  Log[logLevel](JSON.stringify(req.body));
  res.sendStatus(200);
});

//
// Error handling
// -----------------------------------------------------------------------------
const pe = new PrettyError();
pe.skipNodeFiles();
pe.skipPackage('express');

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(pe.render(err));
  const html = ReactDOM.renderToStaticMarkup(
    <Html
      title="服务器内部错误"
      description={err.message}
      styles={[{id: 'css', cssText: errorPageStyle._getCss()}]} // eslint-disable-line no-underscore-dangle
    >
    {ReactDOM.renderToString(<ErrorPageWithoutStyle error={err}/>)}
    </Html>,
  );
  res.status(err.status || 500);
  res.send(`<!doctype html>${html}`);
});

//
// Launch the server
// -----------------------------------------------------------------------------
const promise = models.sync().catch(err => console.error(err.stack));
const httpsServer = https.createServer(credentials, app);
if (cluster.isMaster && needCluster) {
  console.log(`主进程 ${process.pid} 正在运行`);

  // Fork workers.
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    /* eslint-disable no-console */
    console.log('Worker %d died :(', worker.id);
    cluster.fork();
  });
} else {
  if (!module.hot) {
    // promise.then(() => {
    app.listen(config.port, () => {
      console.info(`The server is running at http://localhost:${config.port}/`);
    });
    // });
  }

  console.log(`工作进程 ${process.pid} 已启动`);
}

//
// Hot Module Replacement
// -----------------------------------------------------------------------------
if (module.hot) {
  app.hot = module.hot;
  module.hot.accept('./router');
}

export default app;
