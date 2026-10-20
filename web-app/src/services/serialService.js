/**
 * AttendEdge — Web Serial Hardware Link (Basys 3 / ESP32-CAM UART)
 *
 * Communicates with physical FPGA over USB UART at 115200 baud (8N1).
 * Matches CLKS_PER_BIT = 868 in attendedge_Top.v (100MHz / 115200).
 *
 * If disconnected, the UI displays "Not Connected" and uses the software FSM model.
 */

class SerialService {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.status = 'disconnected'; // 'disconnected' | 'connecting' | 'connected' | 'unsupported'
    this.lastReceivedByte = null;
    this.listeners = new Set();
  }

  isSupported() {
    return 'serial' in navigator;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    this.listeners.forEach(fn => fn({
      status: this.status,
      port: this.port,
      lastReceivedByte: this.lastReceivedByte
    }));
  }

  async connect(baudRate = 115200) {
    if (!this.isSupported()) {
      this.status = 'unsupported';
      this.notify();
      throw new Error('Web Serial API is not supported in this browser. Use Chrome, Edge, or Opera for physical FPGA connection.');
    }

    try {
      this.status = 'connecting';
      this.notify();

      // Request port from user
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' });

      this.status = 'connected';
      this.notify();
      this.startReading();
      return true;
    } catch (err) {
      this.status = 'disconnected';
      this.notify();
      throw err;
    }
  }

  async disconnect() {
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader = null;
      }
      if (this.writer) {
        await this.writer.close();
        this.writer = null;
      }
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
    } catch (err) {
      console.warn('Error closing serial port:', err);
    } finally {
      this.status = 'disconnected';
      this.notify();
    }
  }

  async startReading() {
    while (this.port && this.port.readable && this.status === 'connected') {
      try {
        this.reader = this.port.readable.getReader();
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length > 0) {
            this.lastReceivedByte = value[0];
            this.notify();
          }
        }
      } catch (err) {
        console.error('Serial read error:', err);
        break;
      } finally {
        if (this.reader) {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    }
  }

  /**
   * Send 1 byte student ID (0..62) to FPGA top module:
   * Basys 3 top: ESP32-CAM --UART--> FPGA --UART--> ESP32-CAM
   * ESP32 sends 1 byte = student index (0..62). FPGA replies 1 byte = status code.
   */
  async sendStudentId(studentIndex) {
    if (this.status !== 'connected' || !this.port || !this.port.writable) {
      throw new Error('Hardware FPGA is not connected.');
    }
    const byte = new Uint8Array([studentIndex & 0xFF]);
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(byte);
    } finally {
      writer.releaseLock();
    }
  }
}

export const serialService = new SerialService();
