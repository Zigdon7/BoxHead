/** A browser stays online independently of raid sockets. Each tab owns one
 * connection; a reconnect never changes the selected operator on the server. */
export class Presence {
  private token = '';
  private socket: WebSocket | null = null;
  private retry = 0;

  connect(token: string) {
    if (token === this.token && this.socket) return;
    this.disconnect();
    this.token = token;
    if (token) this.open();
  }

  disconnect() {
    this.token = '';
    window.clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private open() {
    if (!this.token) return;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/presence`);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'presence', token: this.token }));
    socket.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.type === 'presence' && !data.ok) this.disconnect();
    };
    socket.onclose = () => {
      if (this.socket !== socket || !this.token) return;
      this.socket = null;
      this.retry = window.setTimeout(() => this.open(), 3000);
    };
    // Consume connection failures; onclose schedules the retry.
    socket.onerror = () => {};
  }
}
