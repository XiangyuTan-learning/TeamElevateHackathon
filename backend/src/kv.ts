import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

/** Minimal key-value contract. DynamoDB in AWS, a Map locally and in tests. */
export interface Item {
  pk: string;
  sk: string;
  gsi1pk?: string;
  gsi1sk?: string;
  [k: string]: unknown;
}
export interface KV {
  put(item: Item): Promise<void>;
  get(pk: string, sk: string): Promise<Item | undefined>;
  query(pk: string, skPrefix?: string): Promise<Item[]>;
  queryIndex(gsi1pk: string): Promise<Item[]>; // newest first
  del(pk: string, sk: string): Promise<void>;
}

export class MemoryKV implements KV {
  private m = new Map<string, Item>();
  private k = (pk: string, sk: string) => `${pk}\u0000${sk}`;
  async put(item: Item) {
    this.m.set(this.k(item.pk, item.sk), structuredClone(item));
  }
  async get(pk: string, sk: string) {
    const v = this.m.get(this.k(pk, sk));
    return v ? structuredClone(v) : undefined;
  }
  async query(pk: string, skPrefix = '') {
    return [...this.m.values()]
      .filter((i) => i.pk === pk && i.sk.startsWith(skPrefix))
      .sort((a, b) => a.sk.localeCompare(b.sk))
      .map((i) => structuredClone(i));
  }
  async queryIndex(gsi1pk: string) {
    return [...this.m.values()]
      .filter((i) => i.gsi1pk === gsi1pk)
      .sort((a, b) => (b.gsi1sk ?? '').localeCompare(a.gsi1sk ?? ''))
      .map((i) => structuredClone(i));
  }
  async del(pk: string, sk: string) {
    this.m.delete(this.k(pk, sk));
  }
}

export class DynamoKV implements KV {
  private doc: DynamoDBDocumentClient;
  constructor(private table: string, client = new DynamoDBClient({})) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }
  async put(item: Item) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: item }));
  }
  async get(pk: string, sk: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk, sk } }));
    return r.Item as Item | undefined;
  }
  async query(pk: string, skPrefix = '') {
    return this.collect({
      TableName: this.table,
      KeyConditionExpression: skPrefix ? 'pk = :pk AND begins_with(sk, :p)' : 'pk = :pk',
      ExpressionAttributeValues: skPrefix ? { ':pk': pk, ':p': skPrefix } : { ':pk': pk },
    });
  }
  async queryIndex(gsi1pk: string) {
    return this.collect({
      TableName: this.table,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :g',
      ExpressionAttributeValues: { ':g': gsi1pk },
      ScanIndexForward: false,
    });
  }
  async del(pk: string, sk: string) {
    await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk, sk } }));
  }
  private async collect(input: ConstructorParameters<typeof QueryCommand>[0]) {
    const out: Item[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new QueryCommand({ ...input, ExclusiveStartKey: key }));
      out.push(...((r.Items ?? []) as Item[]));
      key = r.LastEvaluatedKey;
    } while (key);
    return out;
  }
}
