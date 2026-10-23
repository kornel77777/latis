import type { LatisApi } from "@latis/shared";

declare global {
  interface Window {
    latis: LatisApi;
  }
}

export const latis: LatisApi = window.latis;
