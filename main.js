import fs from "fs/promises";
import axios from "axios";
import readline from "readline";
import { getBanner } from "./config/banner.js";
import { colors } from "./config/colors.js";
import { Wallet } from "ethers";
import { HttpsProxyAgent } from "https-proxy-agent";

const CONFIG = {
  PING_INTERVAL: 720,
  get PING_INTERVAL_MS() {
    return this.PING_INTERVAL * 60 * 1000;
  },
};

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

class ProxyManager {
  constructor() {
    this.proxies = new Map();
  }

  async initialize() {
    try {
      const data = await fs.readFile("proxy.txt", "utf8");
      return data.split("\n").filter((line) => line.trim() !== "");
    } catch (error) {
      console.error(
        `${colors.error}Error reading proxy.txt: ${error}${colors.reset}`
      );
      return [];
    }
  }

  setProxy(wallet, proxy) {
    this.proxies.set(wallet, proxy);
  }

  getProxy(wallet) {
    return this.proxies.get(wallet);
  }
}

class WalletDashboard {
  constructor() {
    this.wallets = [];
    this.selectedIndex = 0;
    this.currentPage = 0;
    this.walletsPerPage = 5;
    this.isRunning = true;
    this.pingIntervals = new Map();
    this.walletStats = new Map();
    this.privateKeys = new Map();
    this.renderTimeout = null;
    this.lastRender = 0;
    this.minRenderInterval = 100;
    this.proxyManager = new ProxyManager();
  }

  async initialize() {
    try {
      const [data, proxies] = await Promise.all([
        fs.readFile("data.txt", "utf8"),
        this.proxyManager.initialize(),
      ]);

      const privateKeys = data
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 30);
      const validProxies = proxies
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      this.wallets = [];
      this.privateKeys = new Map();

      const initPromises = privateKeys.map(async (privateKey, i) => {
        try {
          const wallet = new Wallet(privateKey);
          const address = wallet.address;
          const proxy = validProxies[i];

          this.wallets.push(address);
          this.privateKeys.set(address, privateKey);
          this.proxyManager.setProxy(address, proxy);

          this.walletStats.set(address, {
            status: "Starting",
            lastPing: "-",
            points: 0,
            error: null,
            proxy: proxy,
            lastClaim: "-",
          });

          await this.startPing(address);
        } catch (error) {
          console.error(
            `${colors.error}Error with key ${privateKey}: ${error.message}${colors.reset}`
          );
        }
      });

      await Promise.all(initPromises);

      if (this.wallets.length === 0) {
        throw new Error("No valid private keys found in data.txt");
      }
    } catch (error) {
      console.error(
        `${colors.error}Error initializing: ${error}${colors.reset}`
      );
      process.exit(1);
    }
  }

  getDashboardApi(wallet) {
    const proxy = this.proxyManager.getProxy(wallet);
    const config = {
      baseURL: "https://dashboard.layeredge.io/api",
      headers: {
        accept: "*/*",
        "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
        "content-type": "application/json",
        origin: "https://dashboard.layeredge.io",
        referer: "https://dashboard.layeredge.io/",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
      },
      timeout: 30000,
    };

    if (proxy) {
      config.httpsAgent = new HttpsProxyAgent(proxy);
      config.proxy = false;
    }

    return axios.create(config);
  }

  getApi(wallet) {
    const proxy = this.proxyManager.getProxy(wallet);
    const config = {
      baseURL: "https://referral-api.layeredge.io/api",
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        Origin: "https://referral-api.layeredge.io",
        Referer: "https://referral-api.layeredge.io/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      timeout: 30000,
      maxRetries: 20,
      retryDelay: 2000,
      retryCondition: (error) => {
        return axios.isNetworkError(error) || error.code === "ETIMEDOUT";
      },
    };

    if (proxy) {
      config.httpsAgent = new HttpsProxyAgent(proxy);
      config.proxy = false;
    }

    return axios.create(config);
  }

  async claimReward(wallet) {
    try {
      const stats = this.walletStats.get(wallet);
      stats.status = "Claiming";
      this.renderDashboard();

      const response = await this.getApi(wallet).post("/claim-points", {
        walletAddress: wallet,
      });

      if (response.data?.success) {
        stats.lastClaim = new Date().toLocaleTimeString();
        return true;
      }
      return false;
    } catch (error) {
      console.error(
        `${colors.error}Claim failed for ${wallet}: ${error.message}${colors.reset}`
      );
      return false;
    }
  }

  async signAndStart(wallet, privateKey) {
    try {
      const walletInstance = new Wallet(privateKey);
      const timestamp = Date.now();
      const message = `Node activation request for ${wallet} at ${timestamp}`;
      const sign = await walletInstance.signMessage(message);

      const response = await this.getApi(wallet).post(
        `/light-node/node-action/${wallet}/start`,
        {
          sign: sign,
          timestamp: timestamp,
        }
      );

      return response.data?.message === "node action executed successfully";
    } catch (error) {
      throw new Error(`Node activation failed: ${error.message}`);
    }
  }

  async checkNodeStatus(wallet, retries = 20) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await this.getApi(wallet).get(
          `/light-node/node-status/${wallet}`
        );
        return response.data?.data?.startTimestamp !== null;
      } catch (error) {
        if (i === retries - 1) {
          if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") {
            throw new Error("Connection timeout");
          }
          if (error.response?.status === 404) {
            throw new Error("Node not found");
          }
          throw new Error(`Check status failed: ${error.message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
    }
  }

  async checkPoints(wallet) {
    try {
      const response = await this.getApi(wallet).get(
        `/referral/wallet-details/${wallet}`
      );
      return response.data?.data?.nodePoints || 0;
    } catch (error) {
      throw new Error(`Check points failed: ${error.message}`);
    }
  }

  async updatePoints(wallet) {
    try {
      const isRunning = await this.checkNodeStatus(wallet);
      if (!isRunning) {
        throw new Error("Node not running");
      }

      const points = await this.checkPoints(wallet);
      return { nodePoints: points };
    } catch (error) {
      if (error.response) {
        switch (error.response.status) {
          case 500:
            throw new Error("Internal Server Error");
          case 504:
            throw new Error("Gateway Timeout");
          case 403:
            throw new Error("Node not activated");
          default:
            throw new Error(`Update points failed: ${error.message}`);
        }
      }
      throw error;
    }
  }

  async startPing(wallet) {
    if (this.pingIntervals.has(wallet)) {
      return;
    }

    const stats = this.walletStats.get(wallet);

    try {
      const privateKey = this.privateKeys.get(wallet);
      if (!privateKey) {
        throw new Error("Private key not found");
      }

      stats.status = "Checking Status";
      this.renderDashboard();

      // Claim reward first
      await this.claimReward(wallet);

      const isRunning = await this.checkNodeStatus(wallet);
      if (!isRunning) {
        stats.status = "Activating";
        this.renderDashboard();

        await this.signAndStart(wallet, privateKey);
        stats.status = "Activated";
        this.renderDashboard();

        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      const result = await this.updatePoints(wallet);
      stats.lastPing = new Date().toLocaleTimeString();
      stats.points = result.nodePoints || stats.points;
      stats.status = "Active";
      stats.error = null;
    } catch (error) {
      stats.status = "Error";
      stats.error = error.message;
      console.error(`Error starting node for ${wallet}:`, error.message);
      return;
    }

    const pingInterval = setInterval(async () => {
      try {
        const result = await this.updatePoints(wallet);
        const stats = this.walletStats.get(wallet);
        stats.lastPing = new Date().toLocaleTimeString();
        stats.points = result.nodePoints || stats.points;
        stats.status = "Active";
        stats.error = null;
      } catch (error) {
        const stats = this.walletStats.get(wallet);
        stats.status = "Error";
        stats.error = error.message;
      }
      this.renderDashboard();
    }, CONFIG.PING_INTERVAL_MS);

    this.pingIntervals.set(wallet, pingInterval);
    this.renderDashboard();
  }

  renderDashboard() {
    const now = Date.now();
    if (now - this.lastRender < this.minRenderInterval) {
      if (this.renderTimeout) {
        clearTimeout(this.renderTimeout);
      }
      this.renderTimeout = setTimeout(() => {
        this.actualRender();
      }, this.minRenderInterval);
      return;
    }
    this.actualRender();
  }

  actualRender() {
    this.lastRender = Date.now();
    let output = [];

    output.push("\x1b[2J\x1b[H");
    output.push(getBanner());

    const startIndex = this.currentPage * this.walletsPerPage;
    const endIndex = Math.min(
      startIndex + this.walletsPerPage,
      this.wallets.length
    );
    const totalPages = Math.ceil(this.wallets.length / this.walletsPerPage);

    for (let i = startIndex; i < endIndex; i++) {
      const wallet = this.wallets[i];
      const stats = this.walletStats.get(wallet);
      const prefix =
        i === this.selectedIndex ? `${colors.cyan}→${colors.reset} ` : "  ";
      const shortWallet = `${wallet.substr(0, 6)}...${wallet.substr(-4)}`;

      output.push(
        `${prefix}Wallet: ${colors.accountName}${shortWallet}${colors.reset}`
      );
      output.push(
        `   Status: ${this.getStatusColor(stats.status)}${stats.status}${
          colors.reset
        }`
      );
      output.push(`   Points: ${colors.info}${stats.points}${colors.reset}`);
      output.push(
        `   Last Ping: ${colors.info}${stats.lastPing}${colors.reset}`
      );
      output.push(
        `   Last Claim: ${colors.info}${stats.lastClaim}${colors.reset}`
      );
      output.push(`   Proxy: ${colors.info}${stats.proxy}${colors.reset}`);
      if (stats.error) {
        output.push(`   Error: ${colors.error}${stats.error}${colors.reset}`);
      }
      output.push("");
    }

    output.push(
      `\n${colors.menuBorder}Page ${this.currentPage + 1}/${totalPages}${
        colors.reset
      }`
    );
    output.push(`\n${colors.menuTitle}Controls:${colors.reset}`);
    output.push(
      `${colors.menuOption}↑/↓: Navigate | ←/→: Change Page | Ctrl+C: Exit${colors.reset}\n`
    );

    process.stdout.write(output.join("\n"));
  }

  getStatusColor(status) {
    switch (status) {
      case "Active":
        return colors.success;
      case "Error":
        return colors.error;
      case "Activated":
        return colors.taskComplete;
      case "Activation Failed":
        return colors.taskFailed;
      case "Starting":
      case "Checking Status":
      case "Activating":
      case "Claiming":
        return colors.taskInProgress;
      default:
        return colors.reset;
    }
  }

  handleKeyPress(str, key) {
    const startIndex = this.currentPage * this.walletsPerPage;
    const endIndex = Math.min(
      startIndex + this.walletsPerPage,
      this.wallets.length
    );
    const totalPages = Math.ceil(this.wallets.length / this.walletsPerPage);

    if (key.name === "up" && this.selectedIndex > startIndex) {
      this.selectedIndex--;
      this.renderDashboard();
    } else if (key.name === "down" && this.selectedIndex < endIndex - 1) {
      this.selectedIndex++;
      this.renderDashboard();
    } else if (key.name === "left" && this.currentPage > 0) {
      this.currentPage--;
      this.selectedIndex = this.currentPage * this.walletsPerPage;
      this.renderDashboard();
    } else if (key.name === "right" && this.currentPage < totalPages - 1) {
      this.currentPage++;
      this.selectedIndex = this.currentPage * this.walletsPerPage;
      this.renderDashboard();
    }
  }

  async start() {
    process.on("SIGINT", function () {
      console.log(`\n${colors.info}Shutting down...${colors.reset}`);
      process.exit();
    });

    process.on("exit", () => {
      for (let [wallet, interval] of this.pingIntervals) {
        clearInterval(interval);
      }
      process.stdin.setRawMode(false);
      process.stdin.pause();
    });

    await this.initialize();
    this.renderDashboard();

    process.stdin.on("keypress", (str, key) => {
      if (key.ctrl && key.name === "c") {
        process.emit("SIGINT");
      } else {
        this.handleKeyPress(str, key);
      }
    });
  }
}

const dashboard = new WalletDashboard();
dashboard.start().catch((error) => {
  console.error(`${colors.error}Fatal error: ${error}${colors.reset}`);
  process.exit(1);
});
