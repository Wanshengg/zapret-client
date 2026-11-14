const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = {
  selectedStrategy: null,
  lastWorkingStrategy: null,
  version: null,
  lastUpdateCheck: null,
  results: [],
  settings: {
    autoStrategy: true,
    autoUpdate: true,
    launchAtStartup: false,
  },
};

class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'settings.json');
    this.data = structuredClone(DEFAULTS);
  }

  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = {
        ...this.data,
        ...saved,
        settings: { ...this.data.settings, ...saved.settings },
        results: Array.isArray(saved.results) ? saved.results.slice(0, 100) : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Settings could not be loaded:', error.message);
    }
    return this.data;
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.data, null, 2));
    await fs.rename(temporary, this.file);
  }

  async patch(values) {
    this.data = { ...this.data, ...values };
    await this.save();
  }

  async patchSettings(values) {
    this.data.settings = { ...this.data.settings, ...values };
    await this.save();
  }

  async addResult(result) {
    this.data.results = [result, ...this.data.results.filter((item) => item.strategy !== result.strategy)].slice(0, 100);
    if (result.success) this.data.lastWorkingStrategy = result.strategy;
    await this.save();
  }
}

module.exports = { Store, DEFAULTS };
