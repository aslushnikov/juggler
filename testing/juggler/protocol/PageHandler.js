"use strict";

const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {TargetRegistry} = ChromeUtils.import("chrome://juggler/content/TargetRegistry.js");
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const XUL_NS = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';
const FRAME_SCRIPT = "chrome://juggler/content/content/ContentSession.js";
const helper = new Helper();

class PageHandler {
  constructor(chromeSession, contentSession) {
    this._chromeSession = chromeSession;
    this._contentSession = contentSession;
    this._pageTarget = TargetRegistry.instance().targetForId(chromeSession.targetId());
    this._browser = TargetRegistry.instance().tabForTarget(chromeSession.targetId()).linkedBrowser;
    this._dialogs = new Map();

    this._eventListeners = [];
    this._enabled = false;
  }

  async close({runBeforeUnload}) {
    // Postpone target close to deliver response in session.
    Services.tm.dispatchToMainThread(() => {
      TargetRegistry.instance().closePage(this._chromeSession.targetId(), runBeforeUnload);
    });
  }

  async enable() {
    if (this._enabled)
      return;
    this._enabled = true;
    this._updateModalDialogs();

    this._eventListeners = [
      helper.addEventListener(this._browser, 'DOMWillOpenModalDialog', async (event) => {
        // wait for the dialog to be actually added to DOM.
        await Promise.resolve();
        this._updateModalDialogs();
      }),
      helper.addEventListener(this._browser, 'DOMModalDialogClosed', event => this._updateModalDialogs()),
      helper.on(TargetRegistry.instance(), TargetRegistry.Events.TargetCrashed, targetId => {
        if (targetId === this._chromeSession.targetId())
          this._chromeSession.emitEvent('Page.crashed', {});
      }),
    ];
  }

  dispose() {
    helper.removeListeners(this._eventListeners);
  }

  async setViewportSize({viewportSize}) {
    const size = this._pageTarget.setViewportSize(viewportSize);
    await this._contentSession.send('Page.awaitViewportDimensions', {
      width: size.width,
      height: size.height
    });
  }

  _updateModalDialogs() {
    const prompts = new Set(this._browser.tabModalPromptBox ? this._browser.tabModalPromptBox.listPrompts() : []);
    for (const dialog of this._dialogs.values()) {
      if (!prompts.has(dialog.prompt())) {
        this._dialogs.delete(dialog.id());
        this._chromeSession.emitEvent('Page.dialogClosed', {
          dialogId: dialog.id(),
        });
      } else {
        prompts.delete(dialog.prompt());
      }
    }
    for (const prompt of prompts) {
      const dialog = Dialog.createIfSupported(prompt);
      if (!dialog)
        continue;
      this._dialogs.set(dialog.id(), dialog);
      this._chromeSession.emitEvent('Page.dialogOpened', {
        dialogId: dialog.id(),
        type: dialog.type(),
        message: dialog.message(),
        defaultValue: dialog.defaultValue(),
      });
    }
  }

  async setFileInputFiles(options) {
    return await this._contentSession.send('Page.setFileInputFiles', options);
  }

  async setEmulatedMedia(options) {
    return await this._contentSession.send('Page.setEmulatedMedia', options);
  }

  async setCacheDisabled(options) {
    return await this._contentSession.send('Page.setCacheDisabled', options);
  }

  async addBinding(options) {
    return await this._contentSession.send('Page.addBinding', options);
  }

  async adoptNode(options) {
    return await this._contentSession.send('Page.adoptNode', options);
  }

  async screenshot(options) {
    return await this._contentSession.send('Page.screenshot', options);
  }

  async getBoundingBox(options) {
    return await this._contentSession.send('Page.getBoundingBox', options);
  }

  async getContentQuads(options) {
    return await this._contentSession.send('Page.getContentQuads', options);
  }

  /**
   * @param {{frameId: string, url: string}} options
   */
  async navigate(options) {
    return await this._contentSession.send('Page.navigate', options);
  }

  /**
   * @param {{frameId: string, url: string}} options
   */
  async goBack(options) {
    return await this._contentSession.send('Page.goBack', options);
  }

  /**
   * @param {{frameId: string, url: string}} options
   */
  async goForward(options) {
    return await this._contentSession.send('Page.goForward', options);
  }

  /**
   * @param {{frameId: string, url: string}} options
   */
  async reload(options) {
    return await this._contentSession.send('Page.reload', options);
  }

  async describeNode(options) {
    return await this._contentSession.send('Page.describeNode', options);
  }

  async scrollIntoViewIfNeeded(options) {
    return await this._contentSession.send('Page.scrollIntoViewIfNeeded', options);
  }

  async addScriptToEvaluateOnNewDocument(options) {
    return await this._contentSession.send('Page.addScriptToEvaluateOnNewDocument', options);
  }

  async removeScriptToEvaluateOnNewDocument(options) {
    return await this._contentSession.send('Page.removeScriptToEvaluateOnNewDocument', options);
  }

  async dispatchKeyEvent(options) {
    return await this._contentSession.send('Page.dispatchKeyEvent', options);
  }

  async dispatchTouchEvent(options) {
    return await this._contentSession.send('Page.dispatchTouchEvent', options);
  }

  async dispatchMouseEvent(options) {
    return await this._contentSession.send('Page.dispatchMouseEvent', options);
  }

  async insertText(options) {
    return await this._contentSession.send('Page.insertText', options);
  }

  async crash(options) {
    return await this._contentSession.send('Page.crash', options);
  }

  async handleDialog({dialogId, accept, promptText}) {
    const dialog = this._dialogs.get(dialogId);
    if (!dialog)
      throw new Error('Failed to find dialog with id = ' + dialogId);
    if (accept)
      dialog.accept(promptText);
    else
      dialog.dismiss();
  }

  async setInterceptFileChooserDialog(options) {
    return await this._contentSession.send('Page.setInterceptFileChooserDialog', options);
  }

  async handleFileChooser(options) {
    return await this._contentSession.send('Page.handleFileChooser', options);
  }

  async sendMessageToWorker(options) {
    return await this._contentSession.send('Page.sendMessageToWorker', options);
  }
}

class Dialog {
  static createIfSupported(prompt) {
    const type = prompt.args.promptType;
    switch (type) {
      case 'alert':
      case 'prompt':
      case 'confirm':
        return new Dialog(prompt, type);
      case 'confirmEx':
        return new Dialog(prompt, 'beforeunload');
      default:
        return null;
    };
  }

  constructor(prompt, type) {
    this._id = helper.generateId();
    this._type = type;
    this._prompt = prompt;
  }

  id() {
    return this._id;
  }

  message() {
    return this._prompt.ui.infoBody.textContent;
  }

  type() {
    return this._type;
  }

  prompt() {
    return this._prompt;
  }

  dismiss() {
    if (this._prompt.ui.button1)
      this._prompt.ui.button1.click();
    else
      this._prompt.ui.button0.click();
  }

  defaultValue() {
    return this._prompt.ui.loginTextbox.value;
  }

  accept(promptValue) {
    if (typeof promptValue === 'string' && this._type === 'prompt')
      this._prompt.ui.loginTextbox.value = promptValue;
    this._prompt.ui.button0.click();
  }
}

var EXPORTED_SYMBOLS = ['PageHandler'];
this.PageHandler = PageHandler;
