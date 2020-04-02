import { readFileSync } from "fs";
import { ShellString, mkdir } from "shelljs";
import path, { basename } from "path";
import * as iconv from "iconv-lite";
import parse from "csv-parse/lib/sync";
import moment from "moment";
import { Config } from "./config/Config";
import CathayBankConfig from "./config/CathayBankConfig";
import { plainToClass } from "class-transformer";
import BeanTransaction from "./BeanTransaction";
import Directive from "./Directive";

enum TxType {
  Deposit = "deposit",
  Withdraw = "withdraw"
}

export class CathayBankParser {
  config: CathayBankConfig;
  basename: string;

  static command = "cathay-bank";
  static options = [
    "-c, --config <config-file>",
    "-i, --input-file <input-csv-file>"
  ];

  constructor(options: any) {
    const config = plainToClass(CathayBankConfig, Config.parse(options.config));
    config.inputFile = options.inputFile;
    config.outputDir = process.cwd();

    this.config = config;
    this.basename = basename(config.inputFile, ".csv");
  }

  parse() {
    const { inputFile, outputDir, encoding } = this.config;

    const originContent = readFileSync(inputFile);
    const encodedContent = iconv.decode(originContent, encoding);

    mkdir("-p", outputDir);
    this.writeEncodedCSV(encodedContent, outputDir);
    const parsed = this.parseCSV(encodedContent);
    const beansContent = this.roastBeans(parsed);
    this.writeBeanFile(beansContent, outputDir);
  }

  writeEncodedCSV(content: string, outputDir: string) {
    const filepath = path.join(outputDir, `${this.basename}.csv`);
    new ShellString(content).to(filepath);
  }

  writeBeanFile(content: string, outputDir: string) {
    const filepath = path.join(outputDir, `${this.basename}.bean`);
    new ShellString(content).to(filepath);
  }

  parseCSV(content: string) {
    const csvOptions = {
      relax_column_count: true,
      columns: true,
      trim: true
    };

    return parse(
      content
        .split("\n")
        .slice(1)
        .join("\n"),
      csvOptions
    );
  }

  getTxType(record): TxType {
    if (record["提出"]) {
      return TxType.Withdraw;
    } else if (record["存入"]) {
      return TxType.Deposit;
    } else {
      throw new Error("Failed to get Transaction Type");
    }
  }

  roastBeans(csvRecords: any): string {
    const txs: BeanTransaction[] = [];
    const { defaultParsingFields, defaultAccount } = this.config;
    const { base: baseAccount } = defaultAccount;
    const rules = {
      deposit: [],
      withdraw: []
    };

    this.config.rules.forEach(rule => {
      rules[rule.type].push(rule);
    });

    let last;
    csvRecords.forEach(record => {
      last = record;
      const date = moment(record["日期"], "YYYYMMDD");
      const narration = ["說明", "備註", "特別備註"]
        .map(key => record[key].trim())
        .join(" ")
        .trim();
      const tx = new BeanTransaction(
        date.format("YYYY-MM-DD"),
        "*",
        "",
        narration
      );

      const txType = this.getTxType(record);
      const matched = rules[txType].some(rule => {
        const { pattern, account, fields = defaultParsingFields } = rule;

        return fields.some(field => {
          const matched = record[field].match(new RegExp(pattern));
          if (matched) {
            if (txType === TxType.Deposit) {
              tx.directives.push(
                new Directive(baseAccount, record["存入"], "TWD"),
                new Directive(account)
              );
            } else {
              tx.directives.push(
                new Directive(account, record["提出"], "TWD"),
                new Directive(baseAccount)
              );
            }
          }
          return matched;
        });
      });

      if (!matched) {
        if (txType === TxType.Deposit) {
          tx.directives.push(
            new Directive(baseAccount, record["存入"], "TWD"),
            new Directive(defaultAccount.deposit)
          );
        } else {
          tx.directives.push(
            new Directive(defaultAccount.withdraw, record["提出"], "TWD"),
            new Directive(baseAccount)
          );
        }
      }
      tx.directives.forEach(d => (d.ambiguousPrice = false));
      txs.push(tx);
    });

    const balanceAmount = last["餘額"];
    const date = moment(last["日期"], "YYYYMMDD")
      .add(1, "day")
      .format("YYYY-MM-DD");
    const balance = `${date} balance ${baseAccount} ${balanceAmount} TWD\n`;

    return txs.map(t => t.toString()).join("\n\n") + "\n\n" + balance;
  }
}
