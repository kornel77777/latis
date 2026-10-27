import type { LattizApi } from "@lattiz/shared";

declare global {
  interface Window {
    lattiz: LattizApi;
  }
}

export const lattiz: LattizApi = window.lattiz;
