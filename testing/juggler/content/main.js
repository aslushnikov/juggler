const {Helper} = ChromeUtils.import('chrome://juggler/content/Helper.js');
const {ContentSession} = ChromeUtils.import('chrome://juggler/content/content/ContentSession.js');
const {FrameTree} = ChromeUtils.import('chrome://juggler/content/content/FrameTree.js');
const {NetworkMonitor} = ChromeUtils.import('chrome://juggler/content/content/NetworkMonitor.js');
const {ScrollbarManager} = ChromeUtils.import('chrome://juggler/content/content/ScrollbarManager.js');

const sessions = new Map();
const frameTree = new FrameTree(docShell);
const networkMonitor = new NetworkMonitor(docShell, frameTree);
const scrollbarManager = new ScrollbarManager(docShell);

const helper = new Helper();

const gListeners = [
  helper.addMessageListener(this, 'juggler:create-content-session', msg => {
    const sessionId = msg.data;
    sessions.set(sessionId, new ContentSession(sessionId, this, frameTree, scrollbarManager, networkMonitor));
  }),

  helper.addMessageListener(this, 'juggler:dispose-content-session', msg => {
    const sessionId = msg.data;
    const session = sessions.get(sessionId);
    if (!session)
      return;
    sessions.delete(sessionId);
    session.dispose();
  }),

  helper.addEventListener(this, 'unload', msg => {
    helper.removeListeners(gListeners);
    for (const session of sessions.values())
      session.dispose();
    sessions.clear();
    scrollbarManager.dispose();
    networkMonitor.dispose();
    frameTree.dispose();
  }),
];

