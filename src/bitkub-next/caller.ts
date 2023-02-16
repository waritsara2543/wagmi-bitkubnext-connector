import {
  ApprovalResponse,
  BitkubNextCallerOptions,
  BitkubNextTXResponse,
  BitkubNextTXStatus,
  ContractCall,
  NetworkMode,
} from "./types";
import { storageKey } from "./constants";
import { requestWindow } from "./utils/request-window";
import axios from "axios";

// BitkubNextCaller is a class that handles the communication with Bitkub Next Wallet.
export class BitkubNextCaller {
  clientId: string;
  network: NetworkMode;
  private readonly walletBaseURL = "https://api.bitkubnext.io/wallets";
  private readonly accountsBaseURL = "https://api.bitkubnext.io/accounts";

  constructor({ clientId, network }: BitkubNextCallerOptions) {
    this.clientId = clientId;
    this.network = network;
  }

  public async callContract({
    contractAddr,
    methodName,
    methodParams,
  }: ContractCall): Promise<BitkubNextTXResponse> {
    try {
      const accessToken = localStorage.getItem(storageKey.ACCESS_TOKEN);
      if (!accessToken) {
        throw new Error("No access token");
      }

      const queueId = await this.requestApproval(
        accessToken,
        contractAddr,
        methodName,
        methodParams,
      );

      await this.waitBKTx(accessToken, queueId);
      const receipt = await (await this.wrapTx(accessToken, queueId)).wait();

      // wait for 15 seconds to make sure the transaction is confirmed
      await new Promise((resolve) => setTimeout(resolve, 1000 * 15));

      return { ...receipt, transactionHash: receipt.tx };
    } catch (e: any) {
      console.error("call contract error:", e);
      throw new Error(e?.error?.message ?? e);
    }
  }

  public async createTxQueueApproval({
    accessToken,
    approvalToken,
  }: {
    accessToken: string;
    approvalToken: string;
  }) {
    const url = `${this.walletBaseURL}/transactions/queue/approval`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "x-next-client-id": this.clientId ? this.clientId : "",
    };

    const body = new URLSearchParams({
      approve_token: approvalToken,
    });

    return axios
      .post(url, body, { headers })
      .then((res) => res.data as { queue_id: string });
  }

  private async requestApproval(
    accessToken: string,
    contractAddr: string,
    methodName: string,
    methodParams: string[],
  ) {
    try {
      const callbackUrl = `${window.origin}/callback`;
      const newWindow = window.open(
        `${window.origin}/callback/loading`,
        "_blank",
        `toolbar=no,
          location=no,
          status=no,
          menubar=no,
          scrollbars=yes,
          resizable=yes,
          width=400px,
          height=600px`,
      );
      const res = await this.createApprovalURL(
        accessToken,
        callbackUrl,
        contractAddr,
        methodName,
        methodParams,
      );

      const queueId = await requestWindow(
        newWindow!,
        res.data.approve_url,
        storageKey.TX_QUEUE_ID,
        storageKey.TX_ERROR,
      );

      localStorage.removeItem(storageKey.TX_QUEUE_ID);
      localStorage.removeItem(storageKey.TX_ERROR);

      return queueId as unknown as string;
    } catch (e) {
      throw e;
    }
  }

  private async createApprovalURL(
    accessToken: string,
    callbackUrl: string,
    contractAddress: string,
    methodName: string,
    methodParams: string[],
  ) {
    const url = `${this.accountsBaseURL}/approvals`;

    const rawDescription = `send ${methodName}(${methodParams.join(", ")})`;
    const description =
      rawDescription.length > 128
        ? rawDescription.substring(0, 125) + "..."
        : rawDescription;

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "x-next-client-id": this.clientId ? this.clientId : "",
    };

    const network = this.network === "testnet" ? "BKC_TESTNET" : "BKC_MAINNET";

    const body = {
      chain: network,
      type: "CONTRACT_CALL",
      description: description,
      callback_url: callbackUrl,
      contract_address: contractAddress,
      contract_method_name: methodName,
      contract_method_params: methodParams,
    };

    /* There's something wrong with methodParams on Fetch API, So we need to use axios */
    return axios
      .post(url, body, { headers })
      .then((res) => res.data as ApprovalResponse);
  }

  private async waitBKTx(
    accessToken: string,
    queueId: string,
    ...targetStatus: BitkubNextTXStatus[]
  ) {
    return new Promise<BitkubNextTXResponse>(async (resolve, reject) => {
      const res = await this.checkTxQueue(accessToken, queueId);

      const sucessStatus =
        targetStatus.length > 0
          ? targetStatus
          : [BitkubNextTXStatus.BROADCASTED, BitkubNextTXStatus.SUCCESS];
      const failStatus = [] as BitkubNextTXStatus[];

      if (sucessStatus.includes(res.status as BitkubNextTXStatus)) {
        resolve(res);
      } else if (failStatus.includes(res.status as BitkubNextTXStatus)) {
        reject(res);
      } else {
        const iv = setInterval(async () => {
          const res = await this.checkTxQueue(accessToken, queueId);
          if (sucessStatus.includes(res.status as BitkubNextTXStatus)) {
            clearInterval(iv);
            resolve(res);
          } else if (failStatus.includes(res.status as BitkubNextTXStatus)) {
            clearInterval(iv);
            reject(res);
          }
        }, 1000);
      }
    });
  }

  private async wrapTx(accessToken: string, queueId: string) {
    return {
      wait: () =>
        this.waitBKTx(accessToken, queueId, BitkubNextTXStatus.SUCCESS),
    };
  }

  private async checkTxQueue(accessToken: string, id: string) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "x-next-client-id": this.clientId ? String(this.clientId) : "",
    };
    // const IdNoQuote = id.replace(/"/g, "");
    let url = `${this.walletBaseURL}/transactions/queue/${id}`;
    const data = (await (
      await fetch(url, { headers })
    ).json()) as BitkubNextTXResponse;
    return data;
  }
}
