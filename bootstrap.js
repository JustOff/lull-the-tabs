let Cc = Components.classes, Ci = Components.interfaces, Cu = Components.utils;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

const branch = "extensions.lull-the-tabs.";
const ON_DEMAND_PREF = "browser.sessionstore.restore_on_demand";
const PINNED_ON_DEMAND_PREF = "browser.sessionstore.restore_pinned_tabs_on_demand";

XPCOMUtils.defineLazyServiceGetter(this, "gSessionStore",
                                   "@mozilla.org/browser/sessionstore;1",
                                   "nsISessionStore");
XPCOMUtils.defineLazyServiceGetter(this, "eTLDService",
                                   "@mozilla.org/network/effective-tld-service;1",
                                   "nsIEffectiveTLDService");
XPCOMUtils.defineLazyServiceGetter(this, "IDNService",
                                   "@mozilla.org/network/idn-service;1",
                                   "nsIIDNService");

let styleSheetService = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
let styleSheetURI = Services.io.newURI("data:text/css," +
  encodeURIComponent(".tabbrowser-tab[pending=true],menuitem.alltabs-item[pending=true]{opacity:.5;}"), null, null);

let domRegex = null, gWindowListener;

function isWhiteListed(aURI) {
  if (domRegex === null) {
    try {
      var exceptionList = Services.prefs.getComplexValue(branch + "exceptionList", Ci.nsISupportsString).data;
      domRegex = new RegExp("^(" + exceptionList.replace(/;/g,"|").replace(/\./g,"\\.").replace(/\*/g,".*") + ")$");
    } catch (e) {
      return false;
    }
  }
  try {
    return domRegex.test(aURI.host);
  } catch (e) {
    // Most likely uri.host failed, so it isn't on the white list.
    return false;
  }
}

function hasPendingAttribute(aTab) {
  return aTab.getAttribute("pending") == "true";
}

/*
 * In relation to a given tab, find the closest tab that is loaded.
 * Note: if there's no such tab available, this will return unloaded
 * tabs as a last resort.
 */
function findClosestLoadedTab(aTab, aTabbrowser) {
  let visibleTabs = aTabbrowser.visibleTabs;

  // Shortcut: if this is the only tab available, we're not going to
  // find another active one, are we...
  if (visibleTabs.length == 1) {
    return null;
  }

  // If leftIsNearest, then try previous sibling first
  if (Services.prefs.getBoolPref(branch + "leftIsNearest") &&
      aTab.previousSibling && !hasPendingAttribute(aTab.previousSibling)) {
    return aTab.previousSibling;
  }

  // The most obvious choice would be the owner tab, if it's active and is
  // part of the same tab group.
  if (aTab.owner
      && Services.prefs.getBoolPref("browser.tabs.selectOwnerOnClose")
      && !hasPendingAttribute(aTab.owner)) {
    let i = 0;
    while (i < visibleTabs.length) {
      if (visibleTabs[i] == aTab.owner) {
        return aTab.owner;
      }
      i++;
    }
  }

  // Otherwise walk the list of visible tabs and see if we can find an
  // active one.
  // To do that, first we need the index of the current tab in the visible-
  // tabs array.
  // However, if the current tab is being closed, it's already been removed
  // from that array. Therefore, we have to also accept its next-higher
  // sibling, if one is found. If one isn't, then the current tab was at
  // the end of the visible-tabs array, and the new end-of-array tab is the
  // best choice for a substitute index.
  let tabIndex = 0;
  while (tabIndex + 1 < visibleTabs.length &&
         visibleTabs[tabIndex] != aTab &&
         visibleTabs[tabIndex] != aTab.nextSibling) {
    // This loop will result in tabIndex pointing to one of three places:
    //    The current tab (visibleTabs[i] == aTab)
    //    The tab which had one index higher than the current tab, until the
    //      current tab was closed (visibleTabs[i] == aTab.nextSibling)
    //    The final tab in the array (tabIndex + 1 == visibleTabs.length)
    tabIndex++;
  }

  let i = 0;
  while ((tabIndex - i >= 0) ||
         (tabIndex + i < visibleTabs.length)) {
    let offsetIncremented = 0;
    if (tabIndex + i < visibleTabs.length) {
      if (!hasPendingAttribute(visibleTabs[tabIndex + i]) &&
          visibleTabs[tabIndex + i] != aTab) {
        // The '!= aTab' test is to rule out the case where i == 0 and
        // aTab is being unloaded rather than closed, so that tabIndex
        // points to aTab instead of its nextSibling.
        return visibleTabs[tabIndex + i];
      }
    }
    if(i == 0 && visibleTabs[tabIndex] != aTab) {
      // This is ugly, but should work.
      // If aTab has been closed, and nextSibling is unloaded, then we
      // have to check previousSibling before the next loop, or we'll take
      // nextSibling.nextSibling (if loaded) over previousSibling, which is
      // closer to the true "x.5" tabIndex offset.
      offsetIncremented = 1;
      i++;
    }
    if (tabIndex - i >= 0) {
      if(!hasPendingAttribute(visibleTabs[tabIndex - i]) &&
         visibleTabs[tabIndex - i] != aTab) {
        return visibleTabs[tabIndex - i];
      }
    }
    if(offsetIncremented > 0) {
      offsetIncremented = 0;
      i--;
    }
    i++;
  }

  // Fallback: there isn't an active tab available, so we're going
  // to have to nominate a non-active one.

  // Start with the owner, if appropriate.
  if (aTab.owner &&
      Services.prefs.getBoolPref("browser.tabs.selectOwnerOnClose")) {
    let i = 0;
    while (i < visibleTabs.length) {
      if (visibleTabs[i] == aTab.owner) {
        return aTab.owner;
      }
      i++;
    }
  }
  // Otherwise, fall back to one of the adjacent tabs.
  if (tabIndex < visibleTabs.length &&
      visibleTabs[tabIndex] != aTab) {
    // aTab was closed, so the tab at its previous index is the correct
    // first choice
    return visibleTabs[tabIndex];
  }
  if (tabIndex + 1 < visibleTabs.length) {
    return visibleTabs[tabIndex + 1];
  }
  if (tabIndex - 1 >= 0) {
    return visibleTabs[tabIndex - 1];
  }

  // If we get this far, something's wrong. It shouldn't be possible for
  // there to not be an adjacent tab unless (visibleTabs.length == 1).
  Cu.reportError("Lull The Tabs: there are " + visibleTabs.length + " visible tabs, which is greater than 1, but no suitable tab was found from index " + tabIndex);
  return null;
}

/**
 * This handler attaches to the tabbrowser.  It listens to various tab
 * related events.
 */
function LullTheTabs(aTabBrowser) {
  this.init(aTabBrowser);
}
LullTheTabs.prototype = {

  init: function(aTabBrowser) {
    this.tabBrowser = aTabBrowser;
    aTabBrowser.LullTheTabs = this;
    let document = aTabBrowser.ownerDocument;

    let tabContextMenu = document.getElementById("tabContextMenu");
    let openTabInWindow = document.getElementById("context_openTabInWindow");

    // add "Unload Tab" menuitem to tab context menu
    let menuitem_unloadTab = document.createElement("menuitem");
    menuitem_unloadTab.setAttribute("id", "lull-the-tabs-unload");
    menuitem_unloadTab.setAttribute("label", "Unload Tab"); // TODO l10n
    menuitem_unloadTab.setAttribute("tbattr", "tabbrowser-multiple");
    menuitem_unloadTab.setAttribute(
      "oncommand", "gBrowser.LullTheTabs.unloadTab(gBrowser.mContextTab);");
    tabContextMenu.insertBefore(menuitem_unloadTab, openTabInWindow);

    // add "Unload Other Tabs" menuitem to tab context menu
    let menuitem_unloadOtherTabs = document.createElement("menuitem");
    menuitem_unloadOtherTabs.setAttribute("id", "lull-the-tabs-unload-others");
    menuitem_unloadOtherTabs.setAttribute("label", "Unload Other Tabs"); // TODO l10n
    menuitem_unloadOtherTabs.setAttribute("tbattr", "tabbrowser-multiple");
    menuitem_unloadOtherTabs.setAttribute(
      "oncommand", "gBrowser.LullTheTabs.unloadOtherTabs(gBrowser.mContextTab);");
    tabContextMenu.insertBefore(menuitem_unloadOtherTabs, openTabInWindow);

    // add "Never Unload" menuitem to tab context menu
    let menuitem_neverUnload = document.createElement("menuitem");
    menuitem_neverUnload.setAttribute("id", "lull-the-tabs-never-unload");
    menuitem_neverUnload.setAttribute("label", "Never Unload Tab"); // TODO l10n
    menuitem_neverUnload.setAttribute("type", "checkbox");
    menuitem_neverUnload.setAttribute("autocheck", "false");
    menuitem_neverUnload.setAttribute(
      "oncommand", "gBrowser.LullTheTabs.toggleWhitelist(gBrowser.mContextTab, event);");
    tabContextMenu.insertBefore(menuitem_neverUnload, openTabInWindow);

    tabContextMenu.addEventListener('popupshowing', this, false);

    this.previousTab = null;
    this.selectedTab = aTabBrowser.selectedTab;

    aTabBrowser.tabContainer.addEventListener('TabOpen', this, false);
    aTabBrowser.tabContainer.addEventListener('TabSelect', this, false);
    aTabBrowser.tabContainer.addEventListener('TabClose', this, false);

    this.prefBranch = Services.prefs.getBranch(branch);
    this.prefBranch.addObserver("", this, false);

    this.startAllTimers();
  },

  done: function(aTabBrowser) {
    let document = aTabBrowser.ownerDocument;

    // remove tab context menu related stuff
    let menuitem_unloadTab = document.getElementById("lull-the-tabs-unload");
    if (menuitem_unloadTab && menuitem_unloadTab.parentNode) {
      menuitem_unloadTab.parentNode.removeChild(menuitem_unloadTab);
    }
    let menuitem_unloadOtherTabs = document.getElementById("lull-the-tabs-unload-others");
    if (menuitem_unloadOtherTabs && menuitem_unloadOtherTabs.parentNode) {
      menuitem_unloadOtherTabs.parentNode.removeChild(menuitem_unloadOtherTabs);
    }
    let menuitem_neverUnload = document.getElementById("lull-the-tabs-never-unload");
    if (menuitem_neverUnload && menuitem_neverUnload.parentNode) {
      menuitem_neverUnload.parentNode.removeChild(menuitem_neverUnload);
    }
    let tabContextMenu = document.getElementById("tabContextMenu");

    tabContextMenu.removeEventListener('popupshowing', this, false);

    aTabBrowser.tabContainer.removeEventListener('TabOpen', this, false);
    aTabBrowser.tabContainer.removeEventListener('TabSelect', this, false);
    aTabBrowser.tabContainer.removeEventListener('TabClose', this, false);

    this.prefBranch.removeObserver("", this);
    this.prefBranch = null;

    this.clearAllTimers();

    this.previousTab = null;
    this.selectedTab = null;


    delete aTabBrowser.LullTheTabs;
    this.tabBrowser = null;
  },

  handleEvent: function(aEvent) {
    switch (aEvent.type) {
      case 'popupshowing':
        this.onPopupShowing(aEvent);
        return;
      case 'TabOpen':
        this.onTabOpen(aEvent);
        return;
      case 'TabSelect':
        this.onTabSelect(aEvent);
        return;
      case 'TabClose':
        this.onTabClose(aEvent);
        return;
    }
  },

  observe: function(aSubject, aTopic, aData) {
    if (aTopic != "nsPref:changed") return;
    switch (aData) {
      case 'autoUnload':
        if (Services.prefs.getBoolPref(branch + "autoUnload")) {
          this.startAllTimers();
        } else {
          this.clearAllTimers();
        }
        break;
      case 'unloadTimeout':
        this.clearAllTimers();
        this.startAllTimers();
        break;
    }
  },

  /**
   * Handle the 'popupshowing' event from "tabContextMenu"
   * and disable "Unload Tab" if the context menu was opened on a pending tab.
   */
  onPopupShowing: function(aEvent) {
    let tabContextMenu = aEvent.originalTarget;
    let document = tabContextMenu.ownerDocument;
    let tab = tabContextMenu.contextTab;
    tab = tab || tabContextMenu.triggerNode.localName == "tab" ?
                 tabContextMenu.triggerNode : this.tabBrowser.selectedTab;

    let menuitem_unloadTab = document.getElementById("lull-the-tabs-unload");
    let menuitem_neverUnload = document.getElementById("lull-the-tabs-never-unload");

    let needlessToUnload = hasPendingAttribute(tab) ||
                           tab.getAttribute("pinned") == "true" &&
                           !(Services.prefs.getBoolPref(PINNED_ON_DEMAND_PREF));

    let host;
    try {
      host = tab.linkedBrowser.currentURI.host;
    } catch (ex) {
      // Most likely uri.host doesn't exist which probably means
      // whitelisting doesn't make sense on this tab.  Set empty
      // host so we don't show the menu item
      host = '';
    }

    if (!host) {
      menuitem_neverUnload.setAttribute("hidden", "true");
      if (needlessToUnload) {
        menuitem_unloadTab.setAttribute("disabled", "true");
      } else {
        menuitem_unloadTab.removeAttribute("disabled");
      }
      return;
    }

    if (isWhiteListed(tab.linkedBrowser.currentURI)) {
      let whitelist = [];
      let wlpref = Services.prefs.getComplexValue(branch + "exceptionList", Ci.nsISupportsString).data;
      if (wlpref) {
        whitelist = wlpref.split(";");
      }
      for (let i = 0; i < whitelist.length; i++) {
        let reg = new RegExp("^" + whitelist[i].replace(/\./g,"\\.").replace(/\*/g,".*") + "$");
        if (reg.test(tab.linkedBrowser.currentURI.host)) {
          host = whitelist[i];
          break;
        }
      }
      menuitem_neverUnload.setAttribute("checked", "true");
      menuitem_unloadTab.setAttribute("disabled", "true");
    } else {
      menuitem_neverUnload.removeAttribute("checked");
      if (needlessToUnload) {
        menuitem_unloadTab.setAttribute("disabled", "true");
      } else {
        menuitem_unloadTab.removeAttribute("disabled");
      }
    }

    menuitem_neverUnload.setAttribute("label", "Keep " + host + " Loaded");
    menuitem_neverUnload.removeAttribute("hidden");
  },

  onTabOpen: function(aEvent) {
    let tab = aEvent.originalTarget;
    if (tab.selected) {
      return;
    }
    this.startTimer(tab);
  },

  onTabSelect: function(aEvent) {
    this.previousTab = this.selectedTab;
    this.selectedTab = aEvent.originalTarget;

    if (this.previousTab) {
      // The previous tab may not be available because it has
      // been closed.
      this.startTimer(this.previousTab);
    }
    this.clearTimer(this.selectedTab);
  },

  onTabClose: function(aEvent) {
    let tab = aEvent.originalTarget;
    this.clearTimer(tab);

    if (tab == this.selectedTab) {
      this.selectedTab = null;
    };
    if (tab == this.previousTab) {
      this.previousTab = null;
    };

    // Check selectOnClose option.
    let selectOnClose = Services.prefs.getIntPref(branch + "selectOnClose");
    if (selectOnClose == 0) {
      // Return if browser default behaviour is selected.
      return;
    }

    // If we are on the selected tab.
    if (tab.selected) {
      if (selectOnClose == 1) {
        // Find the closest tab that isn't unloaded.
        let activeTab = findClosestLoadedTab(tab, this.tabBrowser);
        if (activeTab) {
          this.tabBrowser.selectedTab = activeTab;
        }
      } else {
        // Or select the previous tab.
        if (this.previousTab) {
          this.tabBrowser.selectedTab = this.previousTab;
        }
      }
    }
  },

  /**
   * Unload a tab.
   */
  unloadTab: function(aTab) {
    // Ignore tabs that are already unloaded or are on the host whitelist.
    if (isWhiteListed(aTab.linkedBrowser.currentURI) || hasPendingAttribute(aTab) ||
        !(Services.prefs.getBoolPref(ON_DEMAND_PREF)) ||
        aTab.getAttribute("pinned") == "true" && !(Services.prefs.getBoolPref(PINNED_ON_DEMAND_PREF))) {
      return;
    }

    let tabbrowser = this.tabBrowser;

    // Make sure that we're not on this tab.
    if (aTab.selected) {
      // If we are, then check selectOnUnload option.
      if (Services.prefs.getIntPref(branch + "selectOnUnload") == 0) {
        // Find the closest tab that isn't unloaded.
        let activeTab = findClosestLoadedTab(aTab, tabbrowser);
        if (activeTab) {
          tabbrowser.selectedTab = activeTab;
        }
      } else {
        // Or select the previous tab.
        if (this.previousTab) {
          tabbrowser.selectedTab = this.previousTab;
        }
      }
    }

    let state = gSessionStore.getTabState(aTab);
    let newtab = tabbrowser.addTab(null, {skipAnimation: true});
    // If we ever support a mode where 'browser.sessionstore.max_concurrent_tabs'
    // wasn't set to 0, we'd have to do some trickery here.
    gSessionStore.setTabState(newtab, state);

    // Move the new tab next to the one we're removing, but not in
    // front of it as that confuses Tree Style Tab.
    tabbrowser.moveTabTo(newtab, aTab._tPos + 1);

    // Restore tree when using Tree Style Tab
    if (tabbrowser.treeStyleTab) {
      let parent = tabbrowser.treeStyleTab.getParentTab(aTab);
      if (parent) {
        tabbrowser.treeStyleTab.attachTabTo(newtab, parent,
          {dontAnimate: true, insertBefore: aTab.nextSibling});
      }
      let children = tabbrowser.treeStyleTab.getChildTabs(aTab);
      children.forEach(function(aChild) {
        tabbrowser.treeStyleTab.attachTabTo(
          aChild, newtab, {dontAnimate: true});
      });
    }

    // Close the original tab.  We're taking the long way round to
    // ensure the nsISessionStore service won't save this in the
    // recently closed tabs.
    if (tabbrowser._beginRemoveTab(aTab, true, null, false)) {
      tabbrowser._endRemoveTab(aTab);
    }
  },

  unloadOtherTabs: function(aTab) {
    let tabbrowser = this.tabBrowser;

    // Make sure we're sitting on the tab that isn't going to be unloaded.
    if (tabbrowser.selectedTab != aTab) {
      tabbrowser.selectedTab = aTab;
    }

    // unloadTab() mutates the tabs so the only sane thing to do is to
    // copy the list of tabs now and then work off that list.
    //
    // Which tab list to copy depends on the pref.
    //
    //TODO can we use Array.slice() here?
    let tabs = [];
    let tabSource = tabbrowser.visibleTabs;
    if (!tabSource) {
      return;
    }
    for (let i = 0; i < tabSource.length; i++) {
      tabs.push(tabSource[i]);
    }
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i] != aTab) {
        this.unloadTab(tabs[i]);
      }
    }
  },

  toggleWhitelist: function(aTab, e) {
    let host;
    try {
      host = aTab.linkedBrowser.currentURI.host;
    } catch(ex) {
      // Most likely uri.host doesn't exist.  Ignore then.
      return;
    }

    let whitelist = [];
    let wlpref = Services.prefs.getComplexValue(branch + "exceptionList", Ci.nsISupportsString).data;
    if (wlpref) {
      whitelist = wlpref.split(";");
    }
    if (isWhiteListed(aTab.linkedBrowser.currentURI)) {
      for (let i = 0; i < whitelist.length; i++) {
        let reg = new RegExp("^" + whitelist[i].replace(/\./g,"\\.").replace(/\*/g,".*") + "$");
        if (reg.test(host)) {
          whitelist.splice(i, 1);
          break;
        }
      }
    } else {
      if (e.ctrlKey) {
        try {
          host = "(*.)?" + IDNService.convertACEtoUTF8(eTLDService.getBaseDomainFromHost(host));
        } catch (e) {}
      }
      whitelist.push(host);
    }

    let str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
    str.data = whitelist.join(";");
    Services.prefs.setComplexValue(branch + "exceptionList", Ci.nsISupportsString, str);
    domRegex = null;
  },

  startTimer: function(aTab) {
    if (!Services.prefs.getBoolPref(branch + "autoUnload")) {
      return;
    }
    if (hasPendingAttribute(aTab)) {
      return;
    }

    if (aTab._lullTheTabsTimer) {
      this.clearTimer(aTab);
    }
    let timeout = Services.prefs.getIntPref(branch + "unloadTimeout") * 60 * 1000;
    let window = aTab.ownerDocument.defaultView;
    // Allow 'this' to leak into the inline function
    let self = this;
    aTab._lullTheTabsTimer = window.setTimeout(function() {
      // The timer will be removed automatically since
      // unloadTab() will close and replace the original tab.
      self.tabBrowser.LullTheTabs.unloadTab(aTab);
    }, timeout);
  },

  clearTimer: function(aTab) {
    let window = aTab.ownerDocument.defaultView;
    window.clearTimeout(aTab._lullTheTabsTimer);
    aTab._lullTheTabsTimer = null;
  },

  startAllTimers: function() {
    let visibleTabs = this.tabBrowser.visibleTabs;
    for (let i = 0; i < visibleTabs.length; i++) {
      if (!visibleTabs[i].selected) {
        this.startTimer(visibleTabs[i]);
      }
    }
  },

  clearAllTimers: function() {
    let visibleTabs = this.tabBrowser.visibleTabs;
    for (let i = 0; i < visibleTabs.length; i++) {
      this.clearTimer(visibleTabs[i]);
    }
  },
};

let globalPrefsWatcher = {
  observe: function(aSubject, aTopic, aData) {
    if (aTopic != "nsPref:changed" || aData != "exceptionList") return;

    let exceptionList = Services.prefs.getBranch(branch).getComplexValue("exceptionList", Ci.nsISupportsString).data;
    if (exceptionList == "") {
      Services.prefs.getBranch(branch).clearUserPref("exceptionList");
    }
    domRegex = null;
  },
  register: function() {
    this.prefBranch = Services.prefs.getBranch(branch);
    this.prefBranch.addObserver("", this, false);
  },
  unregister: function() {
    this.prefBranch.removeObserver("", this);
    this.prefBranch = null;
  }
}

function BrowserWindowObserver(aHandlers) {
  this.handlers = aHandlers;
}

BrowserWindowObserver.prototype = {
  observe: function(aSubject, aTopic, aData) {
    if (aTopic == "domwindowopened") {
      aSubject.QueryInterface(Ci.nsIDOMWindow).addEventListener("load", this, false);
    } else if (aTopic == "domwindowclosed") {
      if (aSubject.document.documentElement.getAttribute("windowtype") == "navigator:browser") {
        this.handlers.onShutdown(aSubject);
      }
    }
  },
  handleEvent: function(aEvent) {
    let aWindow = aEvent.currentTarget;
    aWindow.removeEventListener(aEvent.type, this, false);

    if (aWindow.document.documentElement.getAttribute("windowtype") == "navigator:browser") {
      this.handlers.onStartup(aWindow);
    }
  }
};

function browserWindowStartup(aWindow) {
  aWindow.LullTheTabs = new LullTheTabs(aWindow.gBrowser);
}

function browserWindowShutdown(aWindow) {
  aWindow.LullTheTabs.done(aWindow.gBrowser);
  delete aWindow.LullTheTabs;
}

function startup(aData, aReason) {
  let defaultBranch = Services.prefs.getDefaultBranch(branch);
  defaultBranch.setBoolPref("autoUnload", false);
  defaultBranch.setIntPref("unloadTimeout", 120);
  defaultBranch.setCharPref("exceptionList", "");
  defaultBranch.setBoolPref("importBarTab", true);
  defaultBranch.setIntPref("selectOnUnload", 0);
  defaultBranch.setIntPref("selectOnClose", 1);
  defaultBranch.setBoolPref("leftIsNearest", false);

  if (Services.prefs.getBoolPref(branch + "importBarTab")) {
    Services.prefs.setBoolPref(branch + "importBarTab", false);
    try {
      Services.prefs.setCharPref(branch + "exceptionList", Services.prefs.getCharPref("extensions.bartab.whitelist"));
    } catch (e) {}
    try {
      Services.prefs.setBoolPref(branch + "autoUnload", Services.prefs.getBoolPref("extensions.bartab.unloadAfterTimeout"));
      Services.prefs.setIntPref(branch + "unloadTimeout",
                                Math.round(Services.prefs.getIntPref("extensions.bartab.timeoutUnit") *
                                           Services.prefs.getIntPref("extensions.bartab.timeoutValue") / 60));
    } catch (e) {}
    try {
      if (!Services.prefs.getBoolPref("extensions.bartab.findClosestLoadedTab")) {
        Services.prefs.setIntPref(branch + "selectOnClose", 0);
      }
    } catch (e) {}
  }

  if (!styleSheetService.sheetRegistered(styleSheetURI, styleSheetService.USER_SHEET)) {
    styleSheetService.loadAndRegisterSheet(styleSheetURI, styleSheetService.USER_SHEET);
  }

  globalPrefsWatcher.register();

  gWindowListener = new BrowserWindowObserver({
    onStartup: browserWindowStartup,
    onShutdown: browserWindowShutdown
  });
  Services.ww.registerNotification(gWindowListener);

  let winenu = Services.wm.getEnumerator("navigator:browser");
  while (winenu.hasMoreElements()) {
    browserWindowStartup(winenu.getNext());
  }
}

function shutdown(aData, aReason) {
  if (aReason == APP_SHUTDOWN) return;

  Services.ww.unregisterNotification(gWindowListener);
  gWindowListener = null;

  let winenu = Services.wm.getEnumerator("navigator:browser");
  while (winenu.hasMoreElements()) {
    browserWindowShutdown(winenu.getNext());
  }

  globalPrefsWatcher.unregister();

  if (styleSheetService.sheetRegistered(styleSheetURI, styleSheetService.USER_SHEET)) {
    styleSheetService.unregisterSheet(styleSheetURI, styleSheetService.USER_SHEET);
  }
}

function install(aData, aReason) {}
function uninstall(aData, aReason) {}
