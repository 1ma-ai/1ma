export const NAME_MAX = 80;
export const ROLE_MAX = 160;
export const INSTRUCTIONS_MAX = 16_000;
export const MEMORY_MAX = 3_000;
export const FACT_MAX = 500;
export const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const CAPABILITIES_MAX = 16;
export const LETTER_MAX = 12_000;
export const CHAIN_LETTERS_DEFAULT = 6;
export const HOURLY_LETTERS_DEFAULT = 20;
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const RETENTION_DAYS_DEFAULT = 30;
// bb's limit of ids in one call.
export const THREAD_IDS_MAX = 200;
export const REACH_MAX = 5_000;
// Bots named in a bot's instructions: with the longest texts everywhere they
// stay within the 32,768 characters bb gives a plugin, past which it cuts.
export const PEERS_LISTED_MAX = 20;
export const FOUND_MAX = 20;
export const CLI_ROWS_MAX = 200;
