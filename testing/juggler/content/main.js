const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {ContentSession} = ChromeUtils.import('chrome://juggler/content/content/ContentSession.js');
const {FrameTree} = ChromeUtils.import('chrome://juggler/content/content/FrameTree.js');
const {NetworkMonitor} = ChromeUtils.import('chrome://juggler/content/content/NetworkMonitor.js');
const {ScrollbarManager} = ChromeUtils.import('chrome://juggler/content/content/ScrollbarManager.js');

const sessions = new Map();
const scrollbarManager = new ScrollbarManager(docShell);
let frameTree;
let networkMonitor;
const helper = new Helper();
const messageManager = this;
let gListeners;

function createContentSession(sessionId) {
  sessions.set(sessionId, new ContentSession(sessionId, messageManager, frameTree, networkMonitor));
}

function disposeContentSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session)
    return;
  sessions.delete(sessionId);
  session.dispose();
}

function initialize() {
  let response = sendSyncMessage('juggler:content-ready', {})[0];
  if (!response)
    response = { sessionIds: [], browserContextOptions: {}, waitForInitialNavigation: false };

  const { sessionIds, browserContextOptions, waitForInitialNavigation } = response;
  const { userAgent, bypassCSP, javaScriptDisabled, viewport, scriptsToEvaluateOnNewDocument } = browserContextOptions;

  if (userAgent !== undefined)
    docShell.customUserAgent = userAgent;
  if (bypassCSP !== undefined)
    docShell.bypassCSPEnabled = bypassCSP;
  if (javaScriptDisabled !== undefined)
    docShell.allowJavascript = !javaScriptDisabled;
  if (viewport !== undefined) {
    docShell.contentViewer.overrideDPPX = viewport.deviceScaleFactor || this._initialDPPX;
    docShell.deviceSizeIsPageSize = viewport.isMobile;
    docShell.touchEventsOverride = viewport.hasTouch ? Ci.nsIDocShell.TOUCHEVENTS_OVERRIDE_ENABLED : Ci.nsIDocShell.TOUCHEVENTS_OVERRIDE_NONE;
    scrollbarManager.setFloatingScrollbars(viewport.isMobile);
  }

  frameTree = new FrameTree(docShell, waitForInitialNavigation);
  for (const script of scriptsToEvaluateOnNewDocument || [])
    frameTree.addScriptToEvaluateOnNewDocument(script);
  networkMonitor = new NetworkMonitor(docShell, frameTree);
  for (const sessionId of sessionIds)
    createContentSession(sessionId);

  gListeners = [
    helper.addMessageListener(messageManager, 'juggler:create-content-session', msg => {
      const sessionId = msg.data;
      createContentSession(sessionId);
    }),

    helper.addMessageListener(messageManager, 'juggler:dispose-content-session', msg => {
      const sessionId = msg.data;
      disposeContentSession(sessionId);
    }),

    helper.addMessageListener(messageManager, 'juggler:add-script-to-evaluate-on-new-document', msg => {
      const script = msg.data;
      frameTree.addScriptToEvaluateOnNewDocument(script);
    }),

    helper.addEventListener(messageManager, 'unload', msg => {
      helper.removeListeners(gListeners);
      for (const session of sessions.values())
        session.dispose();
      sessions.clear();
      scrollbarManager.dispose();
      networkMonitor.dispose();
      frameTree.dispose();
    }),
  ];
}

initialize();
