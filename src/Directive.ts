export default class Directive {
  account: string;
  amount: string;
  cost: string;
  price: string;
  symbol: string;
  ambiguousPrice: boolean;
  metadata: { [key: string]: string };

  constructor(
    account = "",
    amount = "",
    symbol = "",
    cost = "",
    price = "",
    ambiguousPrice = true,
    metadata = {}
  ) {
    this.account = account;
    this.amount = amount;
    this.symbol = symbol;
    this.cost = cost;
    this.price = price;
    this.metadata = metadata;
    this.ambiguousPrice = ambiguousPrice;
  }

  toString(showMetaData = false) {
    const { account, amount, symbol, cost, price } = this;
    const strArr = [account, amount, symbol];
    if (cost || this.ambiguousPrice) {
      strArr.push(`{${cost}}`);
    }
    if (price) {
      strArr.push(`@ ${price}`);
    }

    const metadata = Object.entries(this.metadata)
      .map(([key, value]) => `    ${key}: "${value}"`)
      .join("\n");

    if (metadata !== "" && showMetaData) {
      return `  ${strArr.join(" ")}\n${metadata}`.trimRight();
    } else {
      return `  ${strArr.join(" ")}`.trimRight();
    }
  }
}
