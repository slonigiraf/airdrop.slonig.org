import request from 'supertest';
import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { ApiPromise, WsProvider } from '@polkadot/api';
import dotenv from 'dotenv';
import type { AccountInfo } from '@polkadot/types/interfaces';
import '@polkadot/api-augment'; // Don't remove: https://github.com/polkadot-js/api/releases/tag/v7.0.1
import BN from 'bn.js';
import { oneSlon } from '../src/utils';
import { KeyringPair } from '@polkadot/keyring/types';

dotenv.config();

const testTimeout = 30_000;
const wsProviderDisconnectTime = 30_000;
jest.setTimeout(testTimeout + wsProviderDisconnectTime);

const BASE_URL = process.env.TEST_URL as string;
const WS_PROVIDER = process.env.WS_PROVIDER || 'wss://ws-parachain-1.slonigiraf.org';
const AIRDROP_SECRET_SEED = process.env.AIRDROP_SECRET_SEED as string;
const AUTH_TOKEN = process.env.AUTH_TOKEN as string;

async function getBalance(api: ApiPromise, address: string): Promise<string> {
    const accountInfo = await api.query.system.account(address) as unknown as AccountInfo;
    return accountInfo.data.free.toString();
}

async function generateTestAccounts(count: number) {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519' });

    const accounts = Array.from({ length: count }, (_, i) => {
        const pair = keyring.addFromUri(`//test${i}`);
        return {
            address: pair.address,
            uri: `//test${i}`,  // store the secret so we can sign from it later
        };
    });

    return accounts;
}
/**
 * Send funds and wait for finalization, unsubscribing along the way.
 */
async function transferAndFinalize(
    api: ApiPromise,
    from: KeyringPair,
    to: string,
    amount: BN
): Promise<void> {
    return new Promise(async (resolve, reject) => {
        try {
            // signAndSend can return an unsubscribe callback
            const unsub = await api.tx.balances
                .transfer(to, amount)
                .signAndSend(from, (result) => {
                    // If the transaction fails, reject
                    if (result.isError) {
                        unsub();
                        return reject(new Error('Transaction failed'));
                    }

                    // If the extrinsic is in a block or finalized, we're good
                    if (result.status.isInBlock || result.status.isFinalized) {
                        unsub(); // unsub is crucial to avoid open handles
                        resolve();
                    }
                });
        } catch (err) {
            reject(err);
        }
    });
}
export async function transferFundsBack(
    api: ApiPromise,
    airdropSeed: string,
    testAccounts: { address: string; uri: string }[]
): Promise<void> {
    await cryptoWaitReady();
    const keyring = new Keyring({ type: 'sr25519' });

    // This is your main "destination" (the account you want to gather funds into)
    const recipient = keyring.addFromUri(airdropSeed);

    await Promise.all(
        testAccounts.map(async (testAccount) => {
            const balance = new BN(await getBalance(api, testAccount.address));
            // Only transfer if there's something above the dust/1 Slon
            if (balance.gt(oneSlon)) {
                const sender = keyring.addFromUri(testAccount.uri);
                // Use the new helper function
                await transferAndFinalize(api, sender, recipient.address, balance.sub(oneSlon));
            }
        })
    );
}


describe('Airdrop API Tests', () => {
    let testAccounts: { address: string; uri: string }[] = [];
    const provider = new WsProvider(WS_PROVIDER);
    let api: ApiPromise;

    beforeAll(async () => {
        api = await ApiPromise.create({ provider });
        testAccounts = await generateTestAccounts(10);
    });

    afterAll(async () => {
        try {
            await transferFundsBack(api, AIRDROP_SECRET_SEED, testAccounts);
        } catch (error) {
            console.error('Error transferring funds:', error);
        }
        await api.disconnect();
        provider.disconnect();
        await new Promise((resolve) => setTimeout(resolve, 100));
    });

    test('Should fail on a wrong auth token', async () => {
        const address = testAccounts[0].address;
        const initialBalance = await getBalance(api, address);
        const response = await request(BASE_URL).get(`/airdrop/?to=${address}&auth=wrong`);
        expect(response.status).toBe(400);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toBe('WRONG_AUTH_TOKEN');
        const sameBalance = await getBalance(api, address);
        expect(BigInt(sameBalance)).toBe(BigInt(initialBalance));
    }, testTimeout);

    test('Receive an airdrop only once', async () => {
        const address = testAccounts[1].address;

        // Fetch initial balance
        const initialBalance = await getBalance(api, address);

        // Request airdrop
        const response = await request(BASE_URL).get(`/airdrop/?to=${address}&auth=${AUTH_TOKEN}`);
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);

        const expectedIncrease = response.body.amount; // Amount in JSON response

        // Fetch new balance
        const finalBalance = await getBalance(api, address);

        // Validate balance increase
        expect(BigInt(finalBalance)).toBe(BigInt(initialBalance) + BigInt(expectedIncrease));

        // Fail to get airdrop twice
        const response2 = await request(BASE_URL).get(`/airdrop/?to=${address}&auth=${AUTH_TOKEN}`);
        expect(response2.status).toBe(400);
        expect(response2.body.success).toBe(false);
        expect(response2.body.error).toBe('DUPLICATED_AIRDROP');
        // Fetch new balance
        const sameBalance = await getBalance(api, address);

        // Validate balance was not increased
        expect(BigInt(sameBalance)).toBe(BigInt(finalBalance));
    }, testTimeout);

    test('Check multiple airdrops and validate balances', async () => {
        const initialBalances = await Promise.all(testAccounts.slice(2).map(account => getBalance(api, account.address)));

        // Request multiple airdrops
        const responses = await Promise.all(
            testAccounts.slice(2).map(account => request(BASE_URL).get(`/airdrop/?to=${account.address}&auth=${AUTH_TOKEN}`))
        );

        responses.forEach(response => {
            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
        });

        const expectedIncreases = responses.map(response => BigInt(response.body.amount));

        const finalBalances = await Promise.all(testAccounts.slice(2).map(account => getBalance(api, account.address)));

        // Validate each balance increase
        finalBalances.forEach((finalBalance, index) => {
            expect(BigInt(finalBalance)).toBe(BigInt(initialBalances[index]) + expectedIncreases[index]);
        });
    }, testTimeout);
});