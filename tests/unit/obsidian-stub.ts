// Just enough of the Obsidian API for the modules under test to load.
export function getLanguage(): string {
  return 'en';
}
export class Notice {
  constructor(public message: string) {}
}
export async function requestUrl(): Promise<never> {
  throw new Error('requestUrl is not available in unit tests');
}
export class App {}
