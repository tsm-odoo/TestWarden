const formatMessages = (...messages: string[]) =>
  messages
    .map((m) =>
      typeof m === "string" ? m : JSON.stringify(m, null, 2)
    )
    .join(" ");

export const formatter = {
  info: (str: string) => `\x1b[37m${str}\x1b[0m`,
  warn: (str: string) => `\x1b[33m${str}\x1b[0m`,
  error: (str : string) => `\x1b[31m${str}\x1b[0m`,
  success: (str: string) => `\x1b[32m${str}\x1b[0m`,
  disabled: (str: string) => `\x1b[90m${str}\x1b[0m`,
  cyan: (str: string) => `\x1b[36m${str}\x1b[0m`,
};

export const logger = {
  info: (...messages: any[]) =>
    console.log(formatter.info(`${formatter.cyan("ℹ")} ${formatMessages(...messages)}`)),
  warn: (...messages: any[]) =>
    console.log(formatter.warn(`⚠️ ${formatMessages(...messages)}`)),
  error: (...messages: any[]) =>
    console.log(formatter.error(`❌ ${formatMessages(...messages)}`)),
  success: (...messages: any[]) =>
    console.log(formatter.success(`✅ ${formatMessages(...messages)}`)),
};
