import dotenv from "dotenv";
import fetch from "node-fetch";
import moment from "moment";
import BigNumber from "bignumber.js";
import { ShellString, mkdir } from "shelljs";
import path from "path";
import Bottleneck from "bottleneck";
import { plainToClass } from "class-transformer";
import { Config } from "./Config";
import Directive from "./Directive";
import BeanTransaction from "./BeanTransaction";
import CryptoConfig from "./CryptoConfig";

dotenv.config();

const ETHERSCAN_BASE_URL = "https://api.etherscan.io/api";
const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

const ethscanLmt = new Bottleneck({
  maxConcurrent: 1,
  minTime: 200
});

const cgcLmt = new Bottleneck({
  maxConcurrent: 1,
  minTime: 600
});

const decimals = new BigNumber(10).pow(18);

enum EthTxType {
  EthTransfer = "ETH Transfer",
  ERC20Transfer = "ERC20 Transfer",
  ERC20Exchange = "ERC20 Exchange",
  ContractExecution = "Contract Execution"
}

export class CryptoParser {
  config: CryptoConfig;

  static command = "crypto";
  static options = ["-c, --config <config-file>"];
  static envs = ["ETHERSCAN_API_KEY"];

  constructor(options: any) {
    this.config = plainToClass(CryptoConfig, Config.parse(options.config));
    this.config.outputDir = process.cwd();
  }

  getValue(value: string, tokenDecimal: string): string {
    const decimals = new BigNumber(10).pow(new BigNumber(tokenDecimal));
    return new BigNumber(value).div(decimals).toFormat();
  }

  getConnection(addr: string, conns: any[]) {
    for (let i = 0; i < conns.length; i++) {
      if (conns[i].address.toLowerCase() === addr) {
        return conns[i];
      }
    }

    return null;
  }

  getDirective(
    sign: string,
    value: string,
    tokenDecimal: string,
    conn: any,
    tokenSymbol: string,
    defaultAccount: string
  ) {
    const val = this.getValue(value, tokenDecimal);
    const account = conn
      ? `${conn.accountPrefix}:${tokenSymbol}`
      : defaultAccount;
    const amount = `${sign}${val}`;
    return new Directive(account, amount, tokenSymbol);
  }

  async getTransaction(hash: string) {
    console.log(`    getting tx ${hash}`);
    const apikey = process.env.ETHERSCAN_API_KEY;
    const txurl = `${ETHERSCAN_BASE_URL}?module=proxy&action=eth_getTransactionByHash&txhash=${hash}&apikey=${apikey}`;
    const receipturl = `${ETHERSCAN_BASE_URL}?module=proxy&action=eth_getTransactionReceipt&txhash=${hash}&apikey=${apikey}`;
    const { result: txResult } = await ethscanLmt.schedule(() =>
      fetch(txurl).then(res => res.json())
    );
    const { result: receiptResult } = await ethscanLmt.schedule(() =>
      fetch(receipturl).then(res => res.json())
    );
    return {
      from: txResult.from,
      to: txResult.to,
      gasUsed: new BigNumber(receiptResult.gasUsed).toString(),
      gasPrice: new BigNumber(txResult.getPrice).toString(),
      hash: txResult.hash,
      value: new BigNumber(txResult.value).toString(),
      timeStamp: "",
      transfers: []
    };
  }

  getERC20Driectives(transfers: any[], conns: any[], defaultAccount: any) {
    const dirs = [];
    transfers.forEach(transfer => {
      const { from, to, tokenSymbol, tokenDecimal, value } = transfer;

      const fromConn = this.getConnection(from, conns);
      const toConn = this.getConnection(to, conns);

      // filter default account if there are more than 1 transfer
      // merged from:
      //   Assets:Crypto:Wallet:SAI -20 SAI
      //   Expenses:Unknown 20 SAI
      //   Income:Unknown -100 CSAI
      //   Assets:Crypto:Wallet:CSAI 100 CSAI
      // to:
      //   Assets:Crypto:Wallet:SAI -20 SAI
      //   Assets:Crypto:Wallet:CSAI 100 CSAI
      if ((fromConn || transfers.length <= 1) && value !== "0") {
        dirs.push(
          this.getDirective(
            "-",
            value,
            tokenDecimal,
            fromConn,
            tokenSymbol,
            defaultAccount.deposit
          )
        );
      }
      if ((toConn || transfers.length <= 1) && value !== "0") {
        dirs.push(
          this.getDirective(
            "",
            value,
            tokenDecimal,
            toConn,
            tokenSymbol,
            defaultAccount.withdraw
          )
        );
      }
    });

    return dirs;
  }

  async fillPrices(beans: BeanTransaction[]) {
    const { fiat } = this.config;
    const map = {};

    beans.forEach(bean => {
      if (!map[bean.date]) {
        map[bean.date] = {};
      }

      const coinsMap = map[bean.date];

      bean.directives.forEach(d => {
        const coin = this.config.coins.find(c => c.symbol === d.symbol);
        if (!coin) {
          return;
        }
        if (!coinsMap[coin.id]) {
          coinsMap[coin.id] = [];
        }

        coinsMap[coin.id].push(d);
      });
    });

    const tasks = [];
    Object.entries(map).forEach(([date, coinsMap]) => {
      Object.keys(coinsMap).forEach(id => {
        const [y, m, d] = date.split("-");
        const coinDate = `${d}-${m}-${y}`;
        const url = `${COINGECKO_BASE_URL}/coins/${id}/history?date=${coinDate}`;
        const task = cgcLmt
          .schedule(() => fetch(url).then(res => res.json()))
          .then((json: any) => {
            json.date = date;
            if (json.error) {
              json.id = id;
            }
            return json;
          });
        tasks.push(task);
      });
    });
    const results = await Promise.all(tasks);
    results.forEach(result => {
      const { date, id, symbol, error } = result;
      if (error) {
        console.error(`cannot find ${id} at ${date}`);
        return;
      }
      map[date][id].forEach(dir => {
        if (!result.market_data) {
          console.error(
            `unexpected result: ${JSON.stringify(result, null, 2)}`
          );
          return;
        }
        if (dir.amount[0] !== "-" && dir.symbol === symbol.toUpperCase()) {
          dir.cost = `${
            result.market_data.current_price[fiat.toLowerCase()]
          } ${fiat}`;
        }
      });
    });
  }

  async roasteBean(): Promise<string> {
    const { connections, defaultAccount } = this.config;
    const beanTxns: BeanTransaction[] = [];
    const ethTxnMap: { [hash: string]: any } = {};
    const apikey = process.env.ETHERSCAN_API_KEY;
    const tokensMetadata = {};
    const balances = [];
    for (let i = 0; i < connections.length; i++) {
      const conn = connections[i];
      console.log(`Process ${conn.accountPrefix}`);

      if (conn.type === "ethereum") {
        const address = conn.address.toLowerCase();
        const txlistUrl = `${ETHERSCAN_BASE_URL}?module=account&action=txlist&address=${address}&apikey=${apikey}`;
        const tokentxUrl = `${ETHERSCAN_BASE_URL}?module=account&action=tokentx&address=${address}&apikey=${apikey}`;
        const txlistRes: any = await ethscanLmt.schedule(() =>
          fetch(txlistUrl).then(res => res.json())
        );
        const tokenRes: any = await ethscanLmt.schedule(() =>
          fetch(tokentxUrl).then(res => res.json())
        );

        txlistRes.result.forEach(tx => {
          if (!ethTxnMap[tx.hash]) {
            ethTxnMap[tx.hash] = tx;
            tx.transfers = [];
            tx.type =
              tx.value === "0"
                ? EthTxType.ContractExecution
                : EthTxType.EthTransfer;
          } else {
            ethTxnMap[tx.hash].value = tx.value;
          }
        });

        tokenRes.result.forEach(async (transfer, i, arr) => {
          console.log(`  process ERC20 tx (${i + 1} / ${arr.length})`);
          transfer.from = transfer.from.toLowerCase();
          transfer.tokenSymbol = transfer.tokenSymbol.toUpperCase();
          if (!tokensMetadata[transfer.tokenSymbol]) {
            tokensMetadata[transfer.tokenSymbol] = {
              contractAddress: transfer.contractAddress,
              tokenDecimal: transfer.tokenDecimal
            };
          }

          if (!ethTxnMap[transfer.hash]) {
            const tx = await this.getTransaction(transfer.hash);
            tx.timeStamp = transfer.timeStamp;
            ethTxnMap[transfer.hash] = tx;
          }

          const tx = ethTxnMap[transfer.hash];
          const duplicated = tx.transfers.some(
            tr =>
              tr.from === transfer.from &&
              tr.to === transfer.to &&
              tr.value === transfer.value
          );

          if (!duplicated) {
            tx.transfers.push(transfer);
            tx.type =
              tx.transfers.length <= 1
                ? EthTxType.ERC20Transfer
                : EthTxType.ERC20Exchange;
          }
        });

        // const lastTokenTx = tokenRes.result.slice().pop();
        // const lastTx = txlistRes.result
        //   .slice()
        //   .pop()
        const lastTx = [tokenRes, txlistRes]
          .map(res => res.result.slice().pop())
          .sort((a, b) => parseInt(a.blockNumber) - parseInt(b.blockNumber))
          .pop();

        const { blockNumber, timeStamp } = lastTx;
        const tag = parseInt(blockNumber).toString(16);
        const date = moment(parseInt(timeStamp) * 1000)
          .add(1, "day")
          .format("YYYY-MM-DD");

        const meta = Object.entries(tokensMetadata);
        for (let j = 0; j < meta.length; j++) {
          const [symbol, info]: [string, any] = meta[j];
          const { contractAddress, tokenDecimal } = info;
          const balanceUrl =
            `${ETHERSCAN_BASE_URL}?module=account&action=tokenbalance` +
            `&contractaddress=${contractAddress}&address=${conn.address}&tag=${tag}&apikey=${apikey}`;
          const { result } = await ethscanLmt.schedule(() =>
            fetch(balanceUrl).then(res => res.json())
          );
          const balance = this.getValue(result, tokenDecimal);
          const account = `${conn.accountPrefix}:${symbol}`;
          balances.push(`${date} balance ${account} ${balance} ${symbol}`);
        }
      }
    }

    const txlist = [...Object.values(ethTxnMap)].sort(
      (a, b) => parseInt(a.timeStamp) - parseInt(b.timeStamp)
    );

    txlist.forEach(tx => {
      const {
        value,
        transfers,
        from,
        to,
        timeStamp,
        gasUsed,
        gasPrice,
        hash,
        type
      } = tx;

      const date = moment(parseInt(timeStamp) * 1000).format("YYYY-MM-DD");

      const gas = new BigNumber(gasUsed)
        .multipliedBy(gasPrice)
        .div(decimals)
        .toString();

      const val = new BigNumber(value).div(decimals).toString();

      const narration = type;
      const beanTx = new BeanTransaction(date, "*", "", narration);
      const { directives, metadata } = beanTx;
      metadata["tx"] = hash;

      const fromConn = this.getConnection(from, connections);

      if (fromConn) {
        directives.push(
          new Directive(defaultAccount.ethTx, gas, "ETH"),
          new Directive(`${fromConn.accountPrefix}:ETH`, `-${gas}`, "ETH")
        );
      }

      // ERC20 transfer or exchange
      if (transfers) {
        const dirs = this.getERC20Driectives(
          transfers,
          connections,
          defaultAccount
        );
        directives.push(...dirs);
      }
      if (val !== "0") {
        const fromConn = this.getConnection(from, connections);
        const toConn = this.getConnection(to, connections);

        directives.push(
          this.getDirective(
            "-",
            value,
            "18",
            fromConn,
            "ETH",
            defaultAccount.deposit
          )
        );

        directives.push(
          this.getDirective(
            "",
            value,
            "18",
            toConn,
            "ETH",
            defaultAccount.withdraw
          )
        );
      }

      beanTx.directives.forEach(dir => {
        const { rules } = this.config;
        rules.forEach(rule => {
          const matched = Object.entries(rule.pattern).some(
            ([key, value]) => dir[key] === value
          );

          if (matched) {
            rule.transform.forEach(({ field, value }) => {
              if (field === "symbol") {
                const regex = new RegExp(`${dir.symbol}$`);
                dir.account = dir.account.replace(regex, value);
              }

              dir[field] = value;
            });
          }
        });
      });

      beanTxns.push(beanTx);
    });

    await this.fillPrices(beanTxns);
    return (
      beanTxns.map(t => t.toString()).join("\n\n") +
      "\n\n" +
      balances.join("\n")
    );
  }

  async parse() {
    const { outputDir } = this.config;

    mkdir("-p", outputDir);
    const beansContent = await this.roasteBean();
    this.writeBeanFile(beansContent, outputDir);
    process.exit(0);
  }

  writeBeanFile(content: string, outputDir: string) {
    const filepath = path.join(outputDir, `${CryptoParser.command}.bean`);
    new ShellString(content).to(filepath);
  }
}
