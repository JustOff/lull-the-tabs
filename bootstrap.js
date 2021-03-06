let Cc = Components.classes, Ci = Components.interfaces, Cu = Components.utils;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

const branch = "extensions.lull-the-tabs.";
const ON_DEMAND_PREF = "browser.sessionstore.restore_on_demand";
const PINNED_ON_DEMAND_PREF = "browser.sessionstore.restore_pinned_tabs_on_demand";
const LOAD_IN_BACKGROUND = "browser.tabs.loadInBackground";

const DEFAULT_PREFS = {
  importBarTab: true,
  showContext: true,
  showButton: true,
  selectOnUnload: 0,
  pauseBackgroundTabs: false,
  openNextToCurrent: false,
  autoUnload: false,
  unloadTimeout: 120,
  exceptionList: "",
  selectOnClose: 1,
  leftIsNearest: false,
};

XPCOMUtils.defineLazyServiceGetter(this, "gSessionStore",
                                   "@mozilla.org/browser/sessionstore;1",
                                   "nsISessionStore");
XPCOMUtils.defineLazyServiceGetter(this, "eTLDService",
                                   "@mozilla.org/network/effective-tld-service;1",
                                   "nsIEffectiveTLDService");
XPCOMUtils.defineLazyServiceGetter(this, "IDNService",
                                   "@mozilla.org/network/idn-service;1",
                                   "nsIIDNService");
XPCOMUtils.defineLazyServiceGetter(this, "gFaviconService",
                                   "@mozilla.org/browser/favicon-service;1",
                                   "nsIFaviconService");
XPCOMUtils.defineLazyServiceGetter(this, "gHistoryService",
                                   "@mozilla.org/browser/nav-history-service;1",
                                   "nsINavHistoryService");
XPCOMUtils.defineLazyModuleGetter(this, "PlacesUtils",
                                  "resource://gre/modules/PlacesUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PrivateBrowsingUtils",
                                  "resource://gre/modules/PrivateBrowsingUtils.jsm");

let styleSheetService = Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService);
let styleSheetURI = Services.io.newURI("chrome://lull-the-tabs/skin/style.css", null, null);

let domRegex = null, gWindowListener;

function initPreferences() {
  let defaultBranch = Services.prefs.getDefaultBranch(branch);
  let syncBranch = Services.prefs.getDefaultBranch("services.sync.prefs.sync." + branch);
  for (let pref in DEFAULT_PREFS) {
    switch (typeof DEFAULT_PREFS[pref]) {
      case "string":
        defaultBranch.setCharPref(pref, DEFAULT_PREFS[pref]);
        break;
      case "number":
        defaultBranch.setIntPref(pref, DEFAULT_PREFS[pref]);
        break;
      case "boolean":
        defaultBranch.setBoolPref(pref, DEFAULT_PREFS[pref]);
        break;
    }
    syncBranch.setBoolPref(pref, true);
  }

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
    try {
      Services.prefs.setBoolPref(branch + "pauseBackgroundTabs", 
                                 Services.prefs.getIntPref("extensions.bartab.loadBackgroundTabs") == 1);
    } catch (e) {}
  }
}

function getHostOrCustomProtoURL(aURI) {
  try {
    return aURI.host;
  } catch (e) {
    let match = /^(\w+:\w+)(\?.+)?$/.exec(aURI.spec);
    if (match) {
      return match[1];
    }
  }
}

function isWhiteListed(aURI) {
  if (domRegex === null) {
    try {
      var exceptionList = Services.prefs.getComplexValue(branch + "exceptionList", Ci.nsISupportsString).data;
      domRegex = new RegExp("^(" + exceptionList.replace(/;/g,"|").replace(/\./g,"\\.").replace(/\*/g,".*") + ")$");
    } catch (e) {
      return false;
    }
  }
  return domRegex.test(getHostOrCustomProtoURL(aURI));
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
      aTab.previousSibling && !aTab.previousSibling.hasAttribute("pending")) {
    return aTab.previousSibling;
  }

  // The most obvious choice would be the owner tab, if it's active and is
  // part of the same tab group.
  if (aTab.owner
      && Services.prefs.getBoolPref("browser.tabs.selectOwnerOnClose")
      && !aTab.owner.hasAttribute("pending")) {
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
      if (!visibleTabs[tabIndex + i].hasAttribute("pending") &&
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
      if(!visibleTabs[tabIndex - i].hasAttribute("pending") &&
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
function LullTheTabs(aWindow) {
  this.init(aWindow);
}
LullTheTabs.prototype = {

  init: function(aWindow) {
    this.browserWindow = aWindow;
    this.tabBrowser = aWindow.gBrowser;
    this.smoothScroll = this.tabBrowser.tabContainer.mTabstrip.smoothScroll;
    this.previousTab = null;
    this.selectedTab = this.tabBrowser.selectedTab;

    this.tabBrowser.tabContainer.addEventListener('TabOpen', this, false);
    this.tabBrowser.tabContainer.addEventListener('TabSelect', this, false);
    this.tabBrowser.tabContainer.addEventListener('TabClose', this, false);

    this.prefBranch = Services.prefs.getBranch(branch);
    this.prefBranch.addObserver("", this, false);

    if (Services.prefs.getBoolPref(branch + "autoUnload")) {
      this.startAllTimers();
    }

    if (Services.prefs.getBoolPref(branch + "showContext")) {
      this.addContext();
    }

    if (Services.prefs.getBoolPref(branch + "showButton")) {
      this.addButton();
    }

    if (Services.prefs.getBoolPref(branch + "pauseBackgroundTabs")) {
      this.hookOpenInBackground();
    }
  },

  done: function() {
    this.clearAllTimers();

    if (Services.prefs.getBoolPref(branch + "showContext")) {
      this.removeContext();
    }

    if (Services.prefs.getBoolPref(branch + "showButton")) {
      this.removeButton();
    }

    if (Services.prefs.getBoolPref(branch + "pauseBackgroundTabs")) {
      this.unhookOpenInBackground();
    }

    this.tabBrowser.tabContainer.removeEventListener('TabOpen', this, false);
    this.tabBrowser.tabContainer.removeEventListener('TabSelect', this, false);
    this.tabBrowser.tabContainer.removeEventListener('TabClose', this, false);

    this.prefBranch.removeObserver("", this);
    this.prefBranch = null;

    this.previousTab = null;
    this.selectedTab = null;
    this.smoothScroll = null;
    this.tabBrowser = null;
    this.browserWindow = null;
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
      case 'TabPinned':
        this.onTabPinned(aEvent);
        return;
      case 'TabUnpinned':
        this.onTabPinned(aEvent);
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
        if (Services.prefs.getBoolPref(branch + "autoUnload")) {
          this.clearAllTimers();
          this.startAllTimers();
        }
        break;
      case 'showContext':
        if (Services.prefs.getBoolPref(branch + "showContext")) {
          this.addContext();
        } else {
          this.removeContext();
        }
        break;
      case 'showButton':
        if (Services.prefs.getBoolPref(branch + "showButton")) {
          this.addButton();
        } else {
          this.removeButton();
        }
        break;
      case 'pauseBackgroundTabs':
        if (Services.prefs.getBoolPref(branch + "pauseBackgroundTabs")) {
          this.hookOpenInBackground();
        } else {
          this.unhookOpenInBackground();
        }
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

    let needlessToUnload = tab.hasAttribute("pending") ||
                           tab.hasAttribute("pinned") &&
                           !Services.prefs.getBoolPref(PINNED_ON_DEMAND_PREF);

    let host = getHostOrCustomProtoURL(tab.linkedBrowser.currentURI);

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
      // If we whitelisting by a wildcard, display it instead of the current host.
      let whitelist = [];
      let wlpref = Services.prefs.getComplexValue(branch + "exceptionList", Ci.nsISupportsString).data;
      if (wlpref) {
        whitelist = wlpref.split(";");
      }
      for (let i = 0; i < whitelist.length; i++) {
        let reg = new RegExp("^" + whitelist[i].replace(/\./g,"\\.").replace(/\*/g,".*") + "$");
        if (reg.test(host)) {
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

    menuitem_neverUnload.setAttribute("label", 'Never Unload "' + host + '"');
    menuitem_neverUnload.removeAttribute("hidden");
  },

  onTabOpen: function(aEvent) {
    let tab = aEvent.originalTarget;
    if (!tab.selected && Services.prefs.getBoolPref(branch + "autoUnload")) {
      this.startTimer(tab);
    }
  },

  onTabSelect: function(aEvent) {
    this.previousTab = this.selectedTab;
    this.selectedTab = aEvent.originalTarget;
    this.selectedTab.removeAttribute("bgpending");

    // The previous tab may not be available because it has been closed.
    if (this.previousTab && Services.prefs.getBoolPref(branch + "autoUnload")) {
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
  unloadTab: function(aTab, aOptions) {
    // Ignore tabs that are pinned, already unloaded or whitelisted, unless the unload is forced.
    if (isWhiteListed(aTab.linkedBrowser.currentURI) && (!aOptions || aOptions && !aOptions.force) ||
        aTab.hasAttribute("pending") || !Services.prefs.getBoolPref(ON_DEMAND_PREF) ||
        aTab.hasAttribute("pinned") && !Services.prefs.getBoolPref(PINNED_ON_DEMAND_PREF)) {
      return;
    }

    // If we were called from the timer and the browser is in full-screen, reschedule the unloading.
    if (aOptions && aOptions.timer && (this.browserWindow.document.fullscreenElement ||
                                       this.browserWindow.document.mozFullScreenElement)) {
      this.startTimer(aTab, 5);
      return;
    }

    let tabbrowser = this.tabBrowser;

    // If we are not in the full reload mode, find a tab to select.
    if (!aOptions || aOptions && (!aOptions.force || !aOptions.reload)) {
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
    }

    // If we were called from the timer, temporarily disable smoothScroll 
    // to avoid undesirable side effects of the addTab() call.
    if (aOptions && aOptions.timer && this.smoothScroll) {
      tabbrowser.tabContainer.mTabstrip.smoothScroll = false;
    }

    let newtab = tabbrowser.addTab(null, {skipAnimation: true});

    if (aOptions && aOptions.timer && this.smoothScroll) {
      // We need to use setTimeout() because addTab() uses it to call _handleNewTab().
      this.browserWindow.setTimeout(function() {
        tabbrowser.tabContainer.mTabstrip.smoothScroll = true;
      }, 0);
    }

    // Copy the session state from the original tab to the new one.
    // If we ever support a mode where 'browser.sessionstore.max_concurrent_tabs'
    // wasn't set to 0, we'd have to do some trickery here.
    gSessionStore.setTabState(newtab, gSessionStore.getTabState(aTab));

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
        // Explicitly detach tabs to prevent them from closing due to a bug in attachTabTo
        tabbrowser.treeStyleTab.detachTab(
          aChild, {dontAnimate: true});
        tabbrowser.treeStyleTab.attachTabTo(
          aChild, newtab, {dontAnimate: true});
      });
    }

    // Restore tree when using Tab Kit 2
    if (this.browserWindow.tabkit && this.browserWindow.tabkit.api) {
      let tk2api = this.browserWindow.tabkit.api;
      let parent = tk2api.getParentTab(aTab);
      if (parent) {
        tk2api.addChildTabs(parent, [newtab]);
      }
      let children = tk2api.getChildTabs(aTab);
      if (children && children.length) {
        tk2api.addChildTabs(newtab, children);
      }
      tk2api.resetTab(aTab);
    }

    // If we are in the full reload mode, select the new tab.
    if (aOptions && aOptions.force && aOptions.reload) {
      tabbrowser.selectedTab = newtab;
    }

    // Close the original tab.  We're taking the long way round to
    // ensure the nsISessionStore service won't save this in the
    // recently closed tabs.
    if (tabbrowser._beginRemoveTab(aTab, true, null, false)) {
      let browser = tabbrowser.getBrowserForTab(aTab);
      if (browser.registeredOpenURI) {
        if (tabbrowser._placesAutocomplete) {
          tabbrowser._placesAutocomplete.unregisterOpenPage(browser.registeredOpenURI);
        } else if (tabbrowser._unifiedComplete) {
          try {
            tabbrowser._unifiedComplete.unregisterOpenPage(browser.registeredOpenURI);
          } catch (e) {
            let userContextId = tabbrowser.getAttribute("usercontextid") || 0;
            tabbrowser._unifiedComplete.unregisterOpenPage(browser.registeredOpenURI, userContextId);
          }
        }
        delete browser.registeredOpenURI;
      }
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
    let host = getHostOrCustomProtoURL(aTab.linkedBrowser.currentURI);
    if (!host) {
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

    if (this.button && aTab == this.tabBrowser.selectedTab) {
      this.updateButton(aTab.linkedBrowser.currentURI);
    }
  },

  startTimer: function(aTab, aTimeout) {
    if (aTab.hasAttribute("pending")) {
      return;
    }
    if (aTab._lullTheTabsTimer) {
      this.clearTimer(aTab);
    }
    let timeout = Services.prefs.getIntPref(branch + "unloadTimeout") * 60 * 1000;
    if (aTimeout) {
      timeout = Math.min(timeout, aTimeout * 60 * 1000);
    }
    let window = aTab.ownerDocument.defaultView;
    // Allow 'this' to leak into the inline function
    let self = this;
    aTab._lullTheTabsTimer = window.setTimeout(function() {
      // The timer will be removed automatically since
      // unloadTab() will close and replace the original tab.
      self.unloadTab(aTab, {timer: true});
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

  addContext: function() {
    let document = this.tabBrowser.ownerDocument;
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
  },

  removeContext: function() {
    let document = this.tabBrowser.ownerDocument;
    let tabContextMenu = document.getElementById("tabContextMenu");

    tabContextMenu.removeEventListener('popupshowing', this, false);

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
  },

  updateButton: function(aURI) {
    if (isWhiteListed(aURI) ||
        this.tabBrowser.selectedTab.hasAttribute("pinned") && 
        !Services.prefs.getBoolPref(PINNED_ON_DEMAND_PREF)) {
      if (!this.button.hasAttribute("protected")) {
        this.button.setAttribute("protected", "true");
        this.button.setAttribute("tooltiptext", "Active tab is protected from unloading");
      }
    } else {
      if (this.button.hasAttribute("protected")) {
        this.button.removeAttribute("protected");
        this.button.setAttribute("tooltiptext", "Unload active tab");
      }
    }
  },

  onLocationChange: function(aWebProgress, aRequest, aLocation, aFlag) {
    this.updateButton(aLocation);
  },

  onTabPinned: function(aEvent) {
    let tab = aEvent.originalTarget;
    if (tab == this.tabBrowser.selectedTab) {
      this.updateButton(tab.linkedBrowser.currentURI);
    }
  },

  onClickButton: function(aEvent) {
    if ((aEvent.ctrlKey || aEvent.metaKey) && aEvent.altKey) {
      this.browserWindow.BrowserOpenAddonsMgr("addons://detail/lull-the-tabs@Off.JustOff/preferences");
    } else {
      this.unloadTab(this.tabBrowser.selectedTab, {force: aEvent.ctrlKey || aEvent.metaKey,
                                                   reload: aEvent.shiftKey});
    }
  },

  addButton: function() {
    let document = this.tabBrowser.ownerDocument;
    let button = document.createElement("image");
    button.setAttribute("id", "lull-the-tabs-button");
    button.setAttribute("class", "urlbar-icon");
    button.setAttribute("tooltiptext", "Unload active tab");
    button.setAttribute("onclick", "gBrowser.LullTheTabs.onClickButton(event);"); 
    let urlBarIcons = document.getElementById("urlbar-icons");
    urlBarIcons.insertBefore(button, urlBarIcons.firstChild);
    this.button = button;
    this.tabBrowser.addProgressListener(this);
    this.tabBrowser.tabContainer.addEventListener('TabPinned', this, false);
    this.tabBrowser.tabContainer.addEventListener('TabUnpinned', this, false);
  },

  removeButton: function() {
    this.tabBrowser.removeProgressListener(this);
    this.tabBrowser.tabContainer.removeEventListener('TabPinned', this, false);
    this.tabBrowser.tabContainer.removeEventListener('TabUnpinned', this, false);
    this.button.parentNode.removeChild(this.button);
    this.button = null;
  },

  openInBackground: function(aWindow, aHref, aTitle, aReferrer) {
    let session = {"entries": [{"url": aHref, "referrer": aReferrer}]};
    if (aTitle != "") {
      session["entries"][0]["title"] = aTitle + ' :: ' + aHref;
    }
    if (aWindow.gBrowser.selectedTab.getAttribute("privateTab-isPrivate")) {
      session["attributes"] = {"privateTab-isPrivate": "true"};
    }
    let asyncFavicons = gFaviconService.QueryInterface(Ci.mozIAsyncFavicons);
    let sHref = aHref.split(/\/+/g);
    asyncFavicons.getFaviconURLForPage(Services.io.newURI(sHref[0] + "//" + sHref[1], null, null), function (aURI) {
      if (aURI && aURI.spec) {
        session["image"] = aURI.spec;
      } else if (typeof sHref[1] == "string") {
        let hist = gHistoryService;
        let hopt = hist.getNewQueryOptions();
        hopt.queryType = Ci.nsINavHistoryQueryOptions.QUERY_TYPE_HISTORY;
        hopt.maxResults = 1;
        let hquery = hist.getNewQuery();
        hquery.domain = sHref[1];
        hquery.domainIsHost = true;
        let hresult = hist.executeQuery(hquery, hopt);
        hresult.root.containerOpen = true;
        if (hresult.root.childCount) {
          let info = hresult.root.getChild(0);
          if (info.icon) {
            session["image"] = info.icon;
          }
        }
        hresult.root.containerOpen = false;
      }
      let newtab = aWindow.gBrowser.addTab(null, {skipAnimation: true});
      gSessionStore.setTabState(newtab, JSON.stringify(session));
      newtab.setAttribute("bgpending", true);
      if (Services.prefs.getBoolPref(branch + "openNextToCurrent")) {
        aWindow.gBrowser.moveTabTo(newtab, aWindow.gBrowser.selectedTab._tPos + 1);
      } else if (Services.prefs.getBoolPref("browser.tabs.insertRelatedAfterCurrent")) {
        let newTabPos = (aWindow.gBrowser._lastRelatedTab || aWindow.gBrowser.selectedTab)._tPos + 1;
        if (aWindow.gBrowser._lastRelatedTab) {
          aWindow.gBrowser._lastRelatedTab.owner = null;
        } else {
          newtab.owner = aWindow.gBrowser.selectedTab;
        }
        aWindow.gBrowser.moveTabTo(newtab, newTabPos);
        aWindow.gBrowser._lastRelatedTab = newtab;
      }
      if (PrivateBrowsingUtils.isWindowPrivate(aWindow) || 
          aWindow.gBrowser.selectedTab.getAttribute("privateTab-isPrivate")) {
        return;
      }
      let places = [{
        uri: Services.io.newURI(aHref, null, null),
        title: aTitle,
        visits: [{
          transitionType: PlacesUtils.history.TRANSITION_LINK,
          visitDate: Date.now() * 1000
        }],
      }];
      PlacesUtils.asyncHistory.updatePlaces(places);
    });
  },

  contextNewTab: function(aWindow, aEvent) {
    let gContextMenu = aWindow.gContextMenu;
    if (Services.prefs.getBoolPref(LOAD_IN_BACKGROUND)) {
      aWindow.urlSecurityCheck(gContextMenu.linkURL, aEvent.target.ownerDocument.nodePrincipal);
      this.openInBackground(aWindow, gContextMenu.linkURL, 
                            gContextMenu.link ? gContextMenu.link.textContent.trim() : "",
                            aWindow.content.location.href);
    } else {
      gContextMenu.openLinkInTab(aEvent);
    }
  },

  hookOpenInBackground: function() {
    let openlinkintab = this.tabBrowser.ownerDocument.getElementById("context-openlinkintab");
    this.bgCommand = openlinkintab.getAttribute("oncommand");
    openlinkintab.setAttribute("oncommand", "gBrowser.LullTheTabs.contextNewTab(window, event);")

    let win = this.browserWindow;
    let openInBackground = this.openInBackground;
    win.original_handleLinkClick = win.handleLinkClick;
    win.handleLinkClick = function(event, href, linkNode){
      // Based on code from /browser/base/content/browser.js from Pale Moon 27.x 
      if (event.button == 2) // right click
        return false;

      let doc = event.target.ownerDocument;

      let where = win.whereToOpenLink(event);
      if (where == "current") {
        // Respect Tab Mix Plus "protected" attribute
        if (win.gBrowser.selectedTab.hasAttribute("protected") &&
            href.split('#')[0] != doc.documentURIObject.specIgnoringRef) {
          where = "tab";
        } else {
          return false;
        }
      }

      if (where == "save") {
        win.saveURL(href, linkNode ? win.gatherTextUnder(linkNode) : "", null, true,
                    true, doc.documentURIObject, doc);
        event.preventDefault();
        return true;
      }

      win.urlSecurityCheck(href, doc.nodePrincipal);
      if (where == "tab" && Services.prefs.getBoolPref(LOAD_IN_BACKGROUND)) {
        openInBackground(win, href, linkNode ? win.gatherTextUnder(linkNode).trim() : "", doc.documentURIObject.spec);
      } else {
        win.openLinkIn(href, where, { referrerURI: doc.documentURIObject, charset: doc.characterSet });
      }
      event.preventDefault();
      return true;
    };
  },

  unhookOpenInBackground: function() {
    this.tabBrowser.ownerDocument.getElementById("context-openlinkintab").setAttribute("oncommand", this.bgCommand);
    this.bgCommand = null;

    this.browserWindow.handleLinkClick = this.browserWindow.original_handleLinkClick;
    delete this.browserWindow.original_handleLinkClick;
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
  aWindow.gBrowser.LullTheTabs = new LullTheTabs(aWindow);
}

function browserWindowShutdown(aWindow) {
  aWindow.gBrowser.LullTheTabs.done();
  delete aWindow.gBrowser.LullTheTabs;
}

function startup(aData, aReason) {
  initPreferences();

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
