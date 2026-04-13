import type {
  RawHeaders,
  TransferrableResponse,
  ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
// @ts-ignore
import { libcurl } from "libcurl.js/bundled";

export type LibcurlClientOptions = {
  wisp: string;
  websocket?: string;
  proxy?: string;
  transport?: string;
  connections?: Array<number>;
  cacert?: string;
};
export default class LibcurlClient implements ProxyTransport {
  session: any;
  wisp: string;
  proxy?: string;
  transport?: string;
  connections?: Array<number>;
  cacert?: string;

  constructor(options: LibcurlClientOptions) {
    this.wisp = options.wisp ?? options.websocket;
    this.transport = options.transport;
    this.proxy = options.proxy;
    this.connections = options.connections;
    this.cacert = options.cacert;
    if (!this.wisp.endsWith("/")) {
      throw new TypeError(
        "The Websocket URL must end with a trailing forward slash."
      );
    }
    if (!this.wisp.startsWith("ws://") && !this.wisp.startsWith("wss://")) {
      throw new TypeError(
        "The Websocket URL must use the ws:// or wss:// protocols."
      );
    }
    if (typeof options.proxy === "string") {
      let protocol = new URL(options.proxy).protocol;
      if (!["socks5h:", "socks4a:", "http:"].includes(protocol)) {
        throw new TypeError(
          "Only socks5h, socks4a, and http proxies are supported."
        );
      }
    }
  }

  async init() {
    if (this.transport) libcurl.transport = this.transport;
    if (!libcurl.ready) {
      await new Promise((resolve, reject) => {
        libcurl.onload = () => {
          console.log("loaded libcurl.js v" + libcurl.version.lib);
          this.ready = true;
          resolve(null);
        };
      });
    }

    libcurl.set_websocket(this.wisp);

    if (this.cacert) {
      libcurl.add_cacert(this.cacert);
    }

    this.session = new libcurl.HTTPSession({
      proxy: this.proxy,
    });

    if (this.connections) this.session.set_connections(...this.connections);

    this.ready = libcurl.ready;
    if (this.ready) {
      console.log("running libcurl.js v" + libcurl.version.lib);
      return;
    }
  }
  ready = false;
  async meta() { }

  async request(
    remote: URL,
    method: string,
    body: BodyInit | null,
    headers: RawHeaders,
    signal: AbortSignal | undefined
  ): Promise<TransferrableResponse> {
    let headersObj: Record<string, string> = {};
    if (headers && typeof headers === "object" && !Array.isArray(headers) && !(Symbol.iterator in headers)) {
      for (const key of Object.keys(headers)) {
        headersObj[key] = (headers as any)[key];
      }
    } else if (headers) {
      for (let [key, value] of headers) {
        headersObj[key] = value;
      }
    }
    let payload = await this.session.fetch(remote.href, {
      method,
      headers: headersObj,
      body,
      redirect: "manual",
      signal: signal,
      _libcurl_verbose: 1,
    });

    const normalizedHeaders: Record<string, string | string[]> = {};
    for (const [rawKey, rawValue] of payload.raw_headers || []) {
      const key = String(rawKey).toLowerCase();
      const value = String(rawValue);
      const existing = normalizedHeaders[key];
      if (existing === undefined) {
        normalizedHeaders[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        normalizedHeaders[key] = [existing, value];
      }
    }

    return {
      body: payload.body!,
      headers: normalizedHeaders as any,
      status: payload.status,
      statusText: payload.statusText,
    };
  }

  connect(
    url: URL,
    protocols: string[],
    requestHeaders: RawHeaders,
    onopen: (protocol: string, extensions: string) => void,
    onmessage: (data: Blob | ArrayBuffer | string) => void,
    onclose: (code: number, reason: string) => void,
    onerror: (error: string) => void
  ): [
      (data: Blob | ArrayBuffer | string) => void,
      (code: number, reason: string) => void,
    ] {
    let headersObj: Record<string, string> = {};
    if (requestHeaders && typeof requestHeaders === "object" && !Array.isArray(requestHeaders) && !(Symbol.iterator in requestHeaders)) {
      for (const key of Object.keys(requestHeaders)) {
        headersObj[key] = (requestHeaders as any)[key];
      }
    } else if (requestHeaders) {
      for (let [key, value] of requestHeaders) {
        headersObj[key] = value;
      }
    }

    let socket = new libcurl.WebSocket(url.toString(), protocols, {
      headers: headersObj,
    });

    socket.binaryType = "arraybuffer";

    socket.onopen = (event: Event) => {
      onopen("", "");
    };
    socket.onclose = (event: CloseEvent) => {
      onclose(event.code, event.reason);
    };
    socket.onerror = (event: Event) => {
      onerror("");
    };
    socket.onmessage = (event: MessageEvent) => {
      onmessage(event.data);
    };

    return [
      (data) => {
        socket.send(data);
      },
      (code, reason) => {
        socket.close(code, reason);
      },
    ];
  }
}

export { LibcurlClient };
