const {XPCOMUtils} = ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
const {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {Dispatcher} = ChromeUtils.import("chrome://juggler/content/protocol/Dispatcher.js");
const {BrowserContextManager} = ChromeUtils.import("chrome://juggler/content/BrowserContextManager.js");
const {NetworkObserver} = ChromeUtils.import("chrome://juggler/content/NetworkObserver.js");
const {TargetRegistry} = ChromeUtils.import("chrome://juggler/content/TargetRegistry.js");
const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const helper = new Helper();

const Cc = Components.classes;
const Ci = Components.interfaces;

const FRAME_SCRIPT = "chrome://juggler/content/content/main.js";

// Command Line Handler
function CommandLineHandler() {
  this._port = -1;
};

CommandLineHandler.prototype = {
  classDescription: "Sample command-line handler",
  classID: Components.ID('{f7a74a33-e2ab-422d-b022-4fb213dd2639}'),
  contractID: "@mozilla.org/remote/juggler;1",
  _xpcom_categories: [{
    category: "command-line-handler",
    entry: "m-juggler"
  }],

  /* nsICommandLineHandler */
  handle: async function(cmdLine) {
    const jugglerFlag = cmdLine.handleFlagWithParam("juggler", false);
    if (!jugglerFlag || isNaN(jugglerFlag))
      return;
    this._port = parseInt(jugglerFlag, 10);
    Services.obs.addObserver(this, 'sessionstore-windows-restored');
  },

  observe: async function(subject, topic) {
    Services.obs.removeObserver(this, 'sessionstore-windows-restored');

    const win = await waitForBrowserWindow();
    BrowserContextManager.initialize();
    NetworkObserver.initialize();
    TargetRegistry.initialize(win, BrowserContextManager.instance());

    const { require } = ChromeUtils.import("resource://devtools/shared/Loader.jsm");
    const WebSocketServer = require('devtools/server/socket/websocket-server');
    this._server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
    this._server.initSpecialConnection(this._port, Ci.nsIServerSocket.KeepWhenOffline | Ci.nsIServerSocket.LoopbackOnly, 4);

    const token = helper.generateId();

    this._server.asyncListen({
      onSocketAccepted: async(socket, transport) => {
        const input = transport.openInputStream(0, 0, 0);
        const output = transport.openOutputStream(0, 0, 0);
        const webSocket = await WebSocketServer.accept(transport, input, output, "/" + token);
        new Dispatcher(webSocket);
      }
    });

    Services.mm.loadFrameScript(FRAME_SCRIPT, true /* aAllowDelayedLoad */);
    dump(`Juggler listening on ws://127.0.0.1:${this._server.port}/${token}\n`);
  },

  QueryInterface: ChromeUtils.generateQI([ Ci.nsICommandLineHandler ]),

  // CHANGEME: change the help info as appropriate, but
  // follow the guidelines in nsICommandLineHandler.idl
  // specifically, flag descriptions should start at
  // character 24, and lines should be wrapped at
  // 72 characters with embedded newlines,
  // and finally, the string should end with a newline
  helpInfo : "  --juggler            Enable Juggler automation\n"
};

var NSGetFactory = XPCOMUtils.generateNSGetFactory([CommandLineHandler]);

/**
 * @return {!Promise<Ci.nsIDOMChromeWindow>}
 */
async function waitForBrowserWindow() {
  const windowsIt = Services.wm.getEnumerator('navigator:browser');
  if (windowsIt.hasMoreElements())
    return waitForWindowLoaded(windowsIt.getNext());

  let fulfill;
  let promise = new Promise(x => fulfill = x);

  const listener = {
    onOpenWindow: window => {
      if (window instanceof Ci.nsIDOMChromeWindow) {
        Services.wm.removeListener(listener);
        fulfill(waitForWindowLoaded(window));
      }
    },
    onCloseWindow: () => {}
  };
  Services.wm.addListener(listener);
  return promise;

  /**
   * @param {!Ci.nsIDOMChromeWindow} window
   * @return {!Promise<Ci.nsIDOMChromeWindow>}
   */
  function waitForWindowLoaded(window) {
    if (window.document.readyState === 'complete')
      return window;
    return new Promise(fulfill => {
      window.addEventListener('load', function listener() {
        window.removeEventListener('load', listener);
        fulfill(window);
      });
    });
  }
}
