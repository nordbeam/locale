import { readFile } from 'node:fs/promises';
export const configName = 'fasti18n.config.json';
export async function readConfig(file, required = false) {
    let text;
    try {
        text = await readFile(file, 'utf8');
    }
    catch (error) {
        if (!required && error.code === 'ENOENT')
            return;
        throw error;
    }
    let value;
    try {
        value = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`${file}: invalid JSON: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${file}: expected a JSON configuration object.`);
    for (const key of ['baseLocale', 'catalogs', 'outDir']) {
        if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key]))
            throw new Error(`${file}: ${key} must be a nonempty string.`);
    }
    return value;
}
