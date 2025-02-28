require('dotenv').config();
const express = require('express');
const { ApiPromise, WsProvider } = require('@polkadot/api');
const { Keyring } = require('@polkadot/keyring');
const { hexToU8a } = require('@polkadot/util');
const mysql = require('mysql2/promise');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize MySQL connection with increased pool size
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 30, // Increased to handle concurrent users
  queueLimit: 0,
});

// Initialize connection to Polkadot node
let api = null;

async function getPolkadotApi() {
  if (!api) {
    const provider = new WsProvider('wss://ws-parachain-1.slonigiraf.org');
    api = await ApiPromise.create({ provider });

    provider.on('disconnected', async () => {
      console.error('❌ Disconnected from Slon node. Reconnecting...');
      setTimeout(getPolkadotApi, 5000); // Reconnect in 5s
    });

    provider.on('error', (error) => {
      console.error('❌ WebSocket Error:', error);
    });

    provider.on('connected', () => {
      console.log('✅ Reconnected to Slon node!');
    });
  }
  return api;
}

// Initialize API on startup
getPolkadotApi();

// Function to get geolocation data from IP
async function getGeolocationData(ipAddress) {
  try {
    if (ipAddress === '127.0.0.1' || ipAddress === 'localhost' || ipAddress.startsWith('192.168.') || ipAddress.startsWith('::1')) {
      return { country: 'Local', countryCode: 'LO', city: 'Local' };
    }

    const cleanIp = ipAddress.split(':')[0].split(',')[0].trim();
    const response = await fetch(`http://ip-api.com/json/${cleanIp}`);
    const data = await response.json();

    return data.status === 'success' ? data : null;
  } catch (error) {
    console.error('Error fetching geolocation data:', error);
    return null;
  }
}

app.get('*', async (req, res) => {
  try {
    const defaultTransferAmount = 10_000_000_000_000;
    const transferAmount = defaultTransferAmount;
    const address = req.query.to;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    if (!address || address.length < 10) {
      return res.status(400).json({ success: false, error: 'Invalid account format.' });
    }

    const api = await getPolkadotApi();
    const secretSeed = process.env.AIRDROP_SECRET_SEED;
    if (!secretSeed) {
      return res.status(500).json({ success: false, error: 'AIRDROP_SECRET_SEED not set' });
    }

    const connection = await pool.getConnection();

    const [existingTransaction] = await connection.query(
      'SELECT 1 FROM airdrop WHERE recipient = ? LIMIT 1',
      [address]
    );
    if (existingTransaction.length > 0) {
      connection.release();
      return res.status(400).json({ success: false, details: 'Your account has previously received funds. If you want more Slon, try getting them from your classmates.' });
    }

    // Prevent race conditions
    await connection.query(
      `INSERT IGNORE INTO airdrop (recipient, amount, tx_hash, ip_address, country, country_code, region, region_name, city, zip, latitude, longitude, timezone, isp) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [address, 0, null, ipAddress, null, null, null, null, null, null, null, null, null, null] // Placeholder for geo data
    );

    // Fetch geolocation data
    const geoData = await getGeolocationData(ipAddress);
    
    const keyring = new Keyring({ type: 'sr25519' });
    const sender = keyring.addFromSeed(hexToU8a(secretSeed));

    // Fetch correct nonce to avoid conflicts
    const nonce = await api.rpc.system.accountNextIndex(sender.address);

    
    const transfer = api.tx.balances.transfer(address, transferAmount);

    transfer.signAndSend(sender, { nonce }, async ({ status, events }) => {
      if (status.isFinalized) {
        const success = events.some(({ event }) => event.section === 'system' && event.method === 'ExtrinsicSuccess');

        if (success) {
          const txHash = transfer.hash.toHex();
          
          // Update the airdrop record with tx hash & geo data
          await connection.query(
            `UPDATE airdrop 
             SET tx_hash = ?, amount = ?, country = ?, country_code = ?, region = ?, region_name = ?, city = ?, zip = ?, latitude = ?, longitude = ?, timezone = ?, isp = ? 
             WHERE recipient = ?`,
            [
              txHash,
              transferAmount,
              geoData?.country || null,
              geoData?.countryCode || null,
              geoData?.region || null,
              geoData?.regionName || null,
              geoData?.city || null,
              geoData?.zip || null,
              geoData?.lat || null,
              geoData?.lon || null,
              geoData?.timezone || null,
              geoData?.isp || null,
              address
            ]
          );

          connection.release();
          return res.json({ success: true, amount: transferAmount, txHash });
        } else {
          console.error('❌ Transaction failed. Admin has probably run out of airdrop funds.');
          res.status(500).json({ success: false, error: 'Admin has probably run out of airdrop funds.' });
        }
      }
    });

  } catch (error) {
    console.error('❌ Error processing request:', error);
    return res.status(500).json({ success: false, details: 'Error processing request.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});