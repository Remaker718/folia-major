# NetEase Heartbeat mode / 网易云心动模式

Sign in to NetEase, open the **Radio** tab and choose **Heartbeat**, or use **Start Heartbeat** in the command palette. Heartbeat starts with a playable song from your liked playlist and adds recommendations as playback approaches the end of its queue. It keeps the usual queue and song-like controls; Personal FM's trash action is not used.

The queue panel shows **Heartbeat is on** and a **Stop Heartbeat** button. Stopping preserves the current song and queue. Starting other music, Personal FM, changing the account/provider, clearing the queue, entering Stage playback or changing loop mode ends the recommendation session. Heartbeat plays sequentially while active without overwriting your saved loop preference.

Heartbeat sessions are kept in memory. Restarting or transferring playback to another window restores an ordinary queue; start Heartbeat again to resume recommendations. Empty liked playlists and failed/empty recommendation responses show a message instead of replacing the current queue.

登录网易云后，在「电台」页点击「心动模式」，或在命令面板执行「开启心动模式」。播放器会从「我喜欢的音乐」选取可播放歌曲，接着添加网易云推荐；临近队列末尾时继续获取推荐。队列面板会显示状态与「退出心动模式」按钮，退出后保留当前歌曲与队列。重新启动软件或切换播放窗口后，需要再次开启心动模式。

## Integration

- UI and account capability checks call `heartbeatPlayback` through the application ports. Provider requests use Omni's `getHeartbeatSongs`; only the NetEase provider and transport know `/playmode/intelligence/list`.
- Heartbeat has its own transient store and request generation. It does not set `isFmMode`, call FM dislike, or introduce separate listening-report behavior.
- Requests that finish after stop, account switch, playback replacement or queue edits cannot take over playback or append to an unrelated queue.
- Automated tests use mocked provider responses. They verify routing, account ownership, cancellation, queue preservation and rendered interactions; a successful real-account recommendation response depends on the configured NetEase backend.
