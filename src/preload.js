'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('hermes', {
  platform: process.platform,
  vault: {
    current: call('vault:current'),
    recent: call('vault:recent'),
    open: call('vault:open'),
    pick: call('vault:pick'),
    reveal: call('vault:reveal'),
    resync: call('index:resync'),
  },
  note: {
    read: call('note:read'),
    write: call('note:write'),
    create: call('note:create'),
    setProps: call('note:setProps'),
    rename: call('note:rename'),
    trash: call('note:trash'),
    meta: call('index:note'),
  },
  index: {
    query: call('index:query'),
    search: call('index:search'),
    propKeys: call('index:propKeys'),
    propValues: call('index:propValues'),
    backlinks: call('index:backlinks'),
    outlinks: call('index:outlinks'),
    tags: call('index:tags'),
    folders: call('index:folders'),
    all: call('index:all'),
    stats: call('index:stats'),
    graph: call('index:graph'),
  },
  views: { list: call('views:list'), save: call('views:save') },
  settings: { get: call('settings:get'), save: call('settings:save') },
  folder: { create: call('folder:create'), rename: call('folder:rename') },
  asset: {
    save: (folder, name, bytes) => ipcRenderer.invoke('asset:save', folder, name, bytes),
    list: call('asset:list'),
    kinds: call('asset:kinds'),
    resolve: call('asset:resolve'),
    open: call('asset:open'),
    trash: call('asset:trash'),
  },
  file: { read: call('file:read') },
  exporter: {
    pdf: call('export:pdf'),
    save: call('export:save'),
    reveal: call('shell:show'),
  },
  setChromeTheme: (colors) => ipcRenderer.send('chrome:theme', colors),
  openExternal: call('shell:open'),
  plugins: { list: call('plugins:list'), folder: call('plugins:folder') },

  on: (channel, fn) => {
    if (channel !== 'vault:changed' && channel !== 'command') return () => {};
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.off(channel, h);
  },
});
