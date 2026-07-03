// Opaque id ringan untuk korelasi sesi/request di content/background/injector.
export function makeId(prefix = 'flab') {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
