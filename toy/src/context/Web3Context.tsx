'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { ethers } from 'ethers';
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  ARBITRUM_SEPOLIA_RPC,
  ADDRESSES,
  HEDGE_ABI,
  MARKET_ABI,
  VAULT_ABI,
  CUSDG_ABI,
  COLLATERAL_ABI,
  POSITIONS_ABI,
  PROTECTED_ABI,
  NFT_ABI,
  USDG_ABI,
  FEED_ABI,
  PERP_ABI,
  USDG_DECIMALS,
} from '../config/contracts';
import { resetCofheClient } from '../lib/cofhe';

export type Role = 'hedger' | 'lp' | 'keeper';

/**
 * Arbitrum's base fee can tick up between the wallet's fee estimate and broadcast, which the node rejects
 * ("max fee per gas less than block base fee"). Set an explicit cap of 3× the latest base fee — Arbitrum
 * only charges the actual base fee, so the headroom costs nothing.
 */
function withFeeHeadroom(signer: ethers.JsonRpcSigner, rpc: ethers.Provider): ethers.JsonRpcSigner {
  const send = signer.sendTransaction.bind(signer);
  signer.sendTransaction = async (tx) => {
    if (tx.maxFeePerGas == null && tx.gasPrice == null) {
      const base = (await rpc.getBlock('latest'))?.baseFeePerGas;
      if (base) tx = { ...tx, maxFeePerGas: base * BigInt(3), maxPriorityFeePerGas: BigInt(0) };
    }
    return send(tx);
  };
  return signer;
}

interface Contracts {
  hedge: ethers.Contract;
  market: ethers.Contract;
  vault: ethers.Contract;
  cusdg: ethers.Contract;
  collateral: ethers.Contract;
  positions: ethers.Contract;
  nft: ethers.Contract;
  usdg: ethers.Contract;
  feed: ethers.Contract;
  perp: ethers.Contract;
  protectedPerp: ethers.Contract;
}

interface Balances {
  eth: string;
  usdg: string;
  rawUsdg: bigint;
}

interface Web3ContextType {
  account: string | null;
  chainId: number | null;
  provider: ethers.Provider | null;
  signer: ethers.Signer | null;
  role: Role;
  setRole: (r: Role) => void;
  isConnected: boolean;
  isConnecting: boolean;
  wrongNetwork: boolean;
  error: string | null;
  balances: Balances;
  read: Contracts; // read-only (RPC provider) — always available
  write: Contracts | null; // signer-connected — needs wallet
  connect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  refresh: () => Promise<void>;
  blockNumber: number;
}

const Web3Context = createContext<Web3ContextType | null>(null);

function buildContracts(runner: ethers.Provider | ethers.Signer): Contracts {
  return {
    hedge: new ethers.Contract(ADDRESSES.hedge, HEDGE_ABI, runner),
    market: new ethers.Contract(ADDRESSES.market, MARKET_ABI, runner),
    vault: new ethers.Contract(ADDRESSES.vault, VAULT_ABI, runner),
    cusdg: new ethers.Contract(ADDRESSES.cusdg, CUSDG_ABI, runner),
    collateral: new ethers.Contract(ADDRESSES.collateral, COLLATERAL_ABI, runner),
    positions: new ethers.Contract(ADDRESSES.positions, POSITIONS_ABI, runner),
    nft: new ethers.Contract(ADDRESSES.positionNFT, NFT_ABI, runner),
    usdg: new ethers.Contract(ADDRESSES.usdg, USDG_ABI, runner),
    feed: new ethers.Contract(ADDRESSES.feed, FEED_ABI, runner),
    perp: new ethers.Contract(ADDRESSES.perp, PERP_ABI, runner),
    protectedPerp: new ethers.Contract(ADDRESSES.protectedPerp, PROTECTED_ABI, runner),
  };
}

export function Web3Provider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [provider, setProvider] = useState<ethers.Provider | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [role, setRole] = useState<Role>('hedger');
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Balances>({ eth: '0.00', usdg: '0.00', rawUsdg: 0n });
  const [blockNumber, setBlockNumber] = useState(0);

  // read-only provider — always present so the cockpit shows live data without a wallet
  const rpcProvider = useMemo(
    () => new ethers.JsonRpcProvider(ARBITRUM_SEPOLIA_RPC, ARBITRUM_SEPOLIA_CHAIN_ID),
    [],
  );
  const read = useMemo(() => buildContracts(rpcProvider), [rpcProvider]);
  const write = useMemo(() => (signer ? buildContracts(signer) : null), [signer]);

  const refresh = useCallback(async () => {
    try {
      const bn = await rpcProvider.getBlockNumber();
      setBlockNumber(bn);
    } catch {
      /* ignore */
    }
    if (!account) return;
    try {
      const [eth, usdg] = await Promise.all([
        rpcProvider.getBalance(account),
        read.usdg.balanceOf(account) as Promise<bigint>,
      ]);
      setBalances({
        eth: Number(ethers.formatEther(eth)).toFixed(4),
        usdg: Number(ethers.formatUnits(usdg, USDG_DECIMALS)).toFixed(2),
        rawUsdg: usdg,
      });
    } catch {
      /* ignore */
    }
  }, [account, read, rpcProvider]);

  const connect = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eth = (typeof window !== 'undefined' ? (window as any).ethereum : null);
    if (!eth) {
      setError('No wallet found. Install MetaMask.');
      return;
    }
    setIsConnecting(true);
    setError(null);
    try {
      const bp = new ethers.BrowserProvider(eth);
      await bp.send('eth_requestAccounts', []);
      const s = withFeeHeadroom(await bp.getSigner(), rpcProvider);
      const net = await bp.getNetwork();
      setProvider(bp);
      setSigner(s);
      setAccount(await s.getAddress());
      setChainId(Number(net.chainId));
      resetCofheClient();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setError((e as any)?.message ?? 'Failed to connect');
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eth = (typeof window !== 'undefined' ? (window as any).ethereum : null);
    if (!eth) return;
    const hexId = '0x' + ARBITRUM_SEPOLIA_CHAIN_ID.toString(16);
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    } catch {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexId,
          chainName: 'Arbitrum Sepolia',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [ARBITRUM_SEPOLIA_RPC],
          blockExplorerUrls: ['https://sepolia.arbiscan.io'],
        }],
      });
    }
  }, []);

  // react to wallet account/chain changes
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eth = (typeof window !== 'undefined' ? (window as any).ethereum : null);
    if (!eth?.on) return;
    const onAccounts = () => { resetCofheClient(); connect(); };
    const onChain = () => window.location.reload();
    eth.on('accountsChanged', onAccounts);
    eth.on('chainChanged', onChain);
    return () => { eth.removeListener?.('accountsChanged', onAccounts); eth.removeListener?.('chainChanged', onChain); };
  }, [connect]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 8000); return () => clearInterval(t); }, [refresh]);

  const value: Web3ContextType = {
    account, chainId, provider, signer, role, setRole,
    isConnected: !!account,
    isConnecting,
    wrongNetwork: !!chainId && chainId !== ARBITRUM_SEPOLIA_CHAIN_ID,
    error, balances, read, write, connect, switchNetwork, refresh, blockNumber,
  };
  return <Web3Context.Provider value={value}>{children}</Web3Context.Provider>;
}

export function useWeb3() {
  const ctx = useContext(Web3Context);
  if (!ctx) throw new Error('useWeb3 must be used within Web3Provider');
  return ctx;
}
