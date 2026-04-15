import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { mainnet, optimism, arbitrum } from "wagmi/chains";

export const config = getDefaultConfig({
  appName: "Safe Pending Tx Signer",
  projectId: "signit-local-dev",
  chains: [mainnet, optimism, arbitrum],
  transports: {
    [mainnet.id]: http(),
    [optimism.id]: http(),
    [arbitrum.id]: http(),
  },
});
