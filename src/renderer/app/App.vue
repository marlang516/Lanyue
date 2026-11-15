<script setup lang="ts">
import { onMounted } from 'vue';
import { ui, bootUi } from './stores/ui';
import { initDownloads } from './stores/download';
import { initOutputSync, restorePlaybackPrefs, restoreQueue } from './stores/player';
import { loadOffset } from './stores/lyrics';
import AppShell from './components/shell/AppShell.vue';
import DiscoverView from './views/DiscoverView.vue';
import SearchView from './views/SearchView.vue';
import LibraryView from './views/LibraryView.vue';
import DownloadView from './views/DownloadView.vue';
import RecentView from './views/RecentView.vue';
import PlaylistView from './views/PlaylistView.vue';
import SettingsView from './views/SettingsView.vue';
import PlaceholderView from './views/PlaceholderView.vue';
import PlayerBar from './components/player/PlayerBar.vue';
import PlayQueueDrawer from './components/player/PlayQueueDrawer.vue';
import NowPlayingView from './views/NowPlayingView.vue';

onMounted(async () => {
  // did-finish-load 的队列快照只发一次。订阅必须在任何 await 之前，
  // 否则用户后来才打开下载页时，启动前就在跑的队列是空的。
  // 桌面歌词 / 迷你播放器同理：窗口打开后来要全量状态，订晚了首帧是空的。
  initDownloads();
  initOutputSync();
  await bootUi();
  await restorePlaybackPrefs();
  await Promise.all([restoreQueue(), loadOffset()]);
});
</script>

<template>
  <AppShell>
    <Transition name="ly-fade" mode="out-in">
      <DiscoverView v-if="ui.view === 'home'" key="home" />
      <SearchView v-else-if="ui.view === 'search'" key="search" />
      <LibraryView v-else-if="ui.view === 'library'" key="library" />
      <DownloadView v-else-if="ui.view === 'download'" key="download" />
      <RecentView v-else-if="ui.view === 'recent'" key="recent" />
      <PlaylistView v-else-if="ui.view === 'playlist'" key="playlist" />
      <SettingsView v-else-if="ui.view === 'settings'" key="settings" />
      <PlaceholderView v-else :id="ui.view" :key="ui.view" />
    </Transition>

    <PlayQueueDrawer />
    <NowPlayingView />

    <template #player>
      <PlayerBar />
    </template>
  </AppShell>
</template>