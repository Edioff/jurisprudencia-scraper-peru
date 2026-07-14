/**
 * Site registry. Adding a site = one adapter file + one entry here.
 */

import { SiteAdapter } from './adapter';
import { OefaAdapter } from './oefa';
import { PjAdapter } from './pj';

const ADAPTERS: SiteAdapter[] = [
  new OefaAdapter(),
  // PJ is only reachable from Peruvian IPs (403 elsewhere); run behind a VPN.
  new PjAdapter(),
];

export function getAdapter(name: string): SiteAdapter {
  const adapter = ADAPTERS.find((a) => a.name === name);
  if (!adapter) {
    const known = ADAPTERS.map((a) => a.name).join(', ');
    throw new Error(`Unknown site "${name}". Available sites: ${known}`);
  }
  return adapter;
}

export function listAdapters(): SiteAdapter[] {
  return [...ADAPTERS];
}
