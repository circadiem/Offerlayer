import { customAlphabet } from "nanoid";

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const nanoid = customAlphabet(alphabet, 16);

export type IdPrefix =
  | "off_"
  | "agt_"
  | "olt_"
  | "ord_"
  | "pay_"
  | "mer_"
  | "tok_"
  | "prn_"
  | "lnk_"
  | "grn_"
  | "man_";

export function newId(prefix: IdPrefix): string {
  return `${prefix}${nanoid()}`;
}

export function newNonce(): string {
  return customAlphabet(alphabet, 22)();
}
