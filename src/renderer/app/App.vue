<script setup lang="ts">
import { onMounted } from 'vue';
import { ui, bootUi } from './stores/ui';
import { restoreQueue } from './stores/player';
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
  await bootUi();
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