import chalk from "chalk";
import logSymbols from "log-symbols";

export const logger = {
  info: (...messages) => console.log(formatter.info(logSymbols.info, ...messages)),
  warn: (...messages) => console.log(formatter.warn(logSymbols.warning, ...messages)),
  error: (...messages) => console.log(formatter.error(logSymbols.error, ...messages)),
  success: (...messages) => console.log(formatter.success(logSymbols.success, ...messages)),
};

export const formatter = {
  info: chalk.white.bind(chalk),
  warn: chalk.yellow.bind(chalk),
  error: chalk.red.bind(chalk),
  success: chalk.green.bind(chalk),
};
