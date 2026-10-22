// The two Tabbit builds. They speak the same protocol and differ only in
// origin, user pool and model catalog, so one plugin can serve both.
export const SITES = {
  "tabbit-ai": {
    id: "tabbit-ai",
    name: "Tabbit AI",
    origin: "https://web.tabbit.ai",
    scene: "chat",
  },
  tabbit: {
    id: "tabbit",
    name: "Tabbit",
    origin: "https://web.tabbit.com",
    scene: "chat",
  },
}

// The model the user allows for testing. It exists on both builds.
export const TEST_MODEL = "DeepSeek-V4.1-Flash"
