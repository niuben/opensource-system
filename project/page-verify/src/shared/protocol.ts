export type ProbeExpectation = {
  expectId: string;
  testId: string;
  property: "text" | "visible";
  condition:
    | { op: "equals"; value: string | boolean }
    | { op: "contains"; value: string };
};

export type ProbeCommand =
  | {
      type: "observe.snapshot";
    }
  | {
      type: "act.click";
      testId: string;
    }
  | {
      type: "assert.expect";
      expectId: string;
    }
  | {
      type: "run.begin";
      expectations: ProbeExpectation[];
    }
  | {
      type: "run.end";
    };

export type PageCommand = {
  type: "command";
  pageId: string;
  runId: string;
  opId: string;
  epoch: number;
  command: ProbeCommand;
};

export type PageMessage =
  | {
      type: "hello";
      pageId: string;
      epoch: number;
      url: string;
      title: string;
      token: string;
    }
  | {
      type: "epoch";
      pageId: string;
      epoch: number;
      url: string;
      title: string;
      reason: "reload" | "hmr";
    }
  | {
      type: "result";
      pageId: string;
      runId: string;
      opId: string;
      epoch: number;
      result: unknown;
    }
  | {
      type: "event";
      pageId: string;
      runId?: string;
      epoch: number;
      seq: number;
      at: number;
      event: {
        type:
          | "runtime.error"
          | "runtime.rejection"
          | "console.error"
          | "network.error"
          | "resource.error";
        message: string;
        url?: string;
        stack?: string;
      };
    };

export type CollectorMessage =
  | { type: "welcome"; pageId: string; epoch: number }
  | PageCommand;

export type PageSummary = {
  pageId: string;
  url: string;
  title: string;
  epoch: number;
  connected: boolean;
  connectedAt: number;
};
