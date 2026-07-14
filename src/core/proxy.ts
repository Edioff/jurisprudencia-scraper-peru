/**
 * Optional proxy rotation.
 *
 * The target government sites have no IP-based anti-bot, so this is OFF by
 * default and the scraper talks to them directly. It exists because the same
 * engine is meant to be pointed at harder sources later: a site that rate-
 * limits or blocks by IP is defeated by spreading requests across a pool of
 * proxies. Wiring that capability in cleanly now — behind an interface, with
 * round-robin rotation — is the difference between "works on these two sites"
 * and "ready for the next one".
 *
 * Uses axios' built-in `proxy` config, so no extra dependency is needed.
 */

import * as fs from 'fs';
import { log } from './logger';

/** axios' proxy shape (host/port/auth/protocol). */
export interface ProxyConfig {
  host: string;
  port: number;
  protocol?: string;
  auth?: { username: string; password: string };
}

export class ProxyPool {
  private readonly proxies: ProxyConfig[];
  private cursor = 0;

  private constructor(proxies: ProxyConfig[]) {
    this.proxies = proxies;
  }

  /** Empty pool → the client goes direct. */
  static empty(): ProxyPool {
    return new ProxyPool([]);
  }

  /**
   * Load proxies from a text file, one URL per line, e.g.
   *   http://user:pass@10.0.0.1:8080
   *   http://10.0.0.2:3128
   * Blank lines and `#` comments are ignored.
   */
  static fromFile(filePath: string): ProxyPool {
    const lines = fs
      .readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const proxies = lines.map(parseProxyUrl).filter((p): p is ProxyConfig => p !== null);
    if (proxies.length === 0) throw new Error(`No usable proxies found in ${filePath}`);
    log.info(`Proxy rotation enabled: ${proxies.length} prox${proxies.length === 1 ? 'y' : 'ies'}`);
    return new ProxyPool(proxies);
  }

  get enabled(): boolean {
    return this.proxies.length > 0;
  }

  /** Next proxy in round-robin order, or null when the pool is empty. */
  next(): ProxyConfig | null {
    if (this.proxies.length === 0) return null;
    const proxy = this.proxies[this.cursor % this.proxies.length];
    this.cursor++;
    return proxy;
  }
}

/** Parse `http://user:pass@host:port` into axios' proxy shape. */
export function parseProxyUrl(raw: string): ProxyConfig | null {
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const config: ProxyConfig = {
      host: url.hostname,
      port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
      protocol: url.protocol.replace(':', ''),
    };
    if (url.username) {
      config.auth = { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
    }
    return config;
  } catch {
    log.warn(`Skipping unparseable proxy: ${raw}`);
    return null;
  }
}
