"use strict";

const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const helper = new Helper();

class RuntimeHandler {
  constructor(chromeSession, contentSession) {
    this._chromeSession = chromeSession;
    this._contentSession = contentSession;
  }

  async enable(options) {
    return await this._contentSession.send('Runtime.enable', options);
  }

  async evaluate(options) {
    return await this._contentSession.send('Runtime.evaluate', options);
  }

  async callFunction(options) {
    return await this._contentSession.send('Runtime.callFunction', options);
  }

  async getObjectProperties(options) {
    return await this._contentSession.send('Runtime.getObjectProperties', options);
  }

  async disposeObject(options) {
    return await this._contentSession.send('Runtime.disposeObject', options);
  }

  dispose() {}
}

var EXPORTED_SYMBOLS = ['RuntimeHandler'];
this.RuntimeHandler = RuntimeHandler;
