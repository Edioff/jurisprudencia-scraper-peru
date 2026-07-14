/**
 * Site registry. Adding a site = one adapter file + one entry here.
 */

import { SiteAdapter } from './adapter';
import { OefaAdapter } from './oefa';

const ADAPTERS: SiteAdapter[] = [
  new OefaAdapter(),
  // PJ (jurisprudencia.pj.gob.pe) adapter lands here — the site is only
  // reachable from Peruvian IPs, so it is developed/verified behind a VPN.
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
