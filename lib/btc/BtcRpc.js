const BitcoinRPC = require('./bitcoin');
const promptly = require('promptly');
const util = require('util');
const EventEmitter = require('events');

const passwordPromptAsync = util.promisify(promptly.password);

class BtcRpc {
  constructor(config) {
    this.config = config;
    const {
      rpcPort: port,
      rpcUser: user,
      rpcPass: pass,
      host,
      protocol
    } = config;
    this.rpc = new BitcoinRPC({ host, port, user, pass, protocol });
    this.emitter = new EventEmitter();
  }

  asyncCall(method, args) {
    return new Promise((resolve, reject) => {
      this.rpc[method](...args, (err, response) => {
        if (err instanceof Error) {
          return reject(err);
        }

        const { error, result } = response;
        if (error) {
          err = new Error(error.message);
          err.code = error.code; // used by methods below
          err.conclusive = true; // used by server
          return reject(err);
        }
        if (result && result.errors) {
          return reject(new Error(result.errors[0]));
        }
        return resolve(result);
      });
    });
  }

  async cmdlineUnlock({ time }) {
    return this.asyncCall('cmdlineUnlock', [time]);
  }

  async sendMany({ account, batch, options }) {
    let batchClone = Object.assign({}, batch);
    for (let tx in batch) {
      batchClone[tx] /= 1e8;
    }
    if (!account) {
      account = '';
    }
    const paramArray = [account, batchClone];
    if (options) {
      paramArray.push(options);
    }
    return this.asyncCall('sendMany', paramArray);
  }

  async sendToAddress({ address, amount }) {
    return this.asyncCall('sendToAddress', [address, amount / 1e8]);
  }

  async unlockAndSendToAddress({ address, amount, passphrase }) {
    if (passphrase === undefined) {
      passphrase = await passwordPromptAsync('> ');
    }
    await this.walletUnlock({ passphrase, time: 10800 });
    const tx = await this.sendToAddress({ address, amount });
    await this.walletLock();
    return tx;
  }

  async unlockAndSendToAddressMany({ account, payToArray, passphrase, time = 10800, maxValue = 10*1e8, maxOutputs = 1 }) {
    let payToArrayClone = [...payToArray];
    if (passphrase === undefined) {
      passphrase = await passwordPromptAsync('> ');
    }
    await this.walletUnlock({ passphrase, time });
    let payToArrayResult = [];
    while (payToArrayClone.length) {
      let currentValue = 0;
      let currentOutputs = 0;
      let paymentsObj = {};
      let paymentsArr = [];
      if (payToArrayClone.length < maxOutputs) {
        maxOutputs = payToArrayClone.length;
      }
      while (currentValue < maxValue && currentOutputs < maxOutputs) {
        const {address, amount, id} = payToArrayClone.shift();
        paymentsArr.push({ address, amount, id });
        const emitAttempt = {
          address,
          amount,
          id
        };
        this.emitter.emit('attempt', emitAttempt);
        if (!paymentsObj[address]) {
          paymentsObj[address] = 0;
        }
        paymentsObj[address] += amount;
        currentValue += amount;
        currentOutputs++;
      }
      let emitData = {
        txid: '',
        vout: '',
        id: '',
        amount: '',
        address: '',
      };
      let txid;
      let txDetails;
      try {
        txid = await this.sendMany({ account, batch:paymentsObj });
        emitData.txid = txid;
      } catch (error) {
        emitData.error = error;
      }
      try {
        if (txid) {
          txDetails = await this.getTransaction({ txid });
        }
      } catch (error) {
        console.error(`Unable to get transaction details for txid: ${txid}.`);
        console.error(error);
      }
      for (let payment of paymentsArr) {
        if (txDetails && txDetails.vout) {
          for (let vout of txDetails.vout) {
            if (
              vout.scriptPubKey.address === payment.address ||
              // Legacy
              (Array.isArray(vout.scriptPubKey.addresses) && vout.scriptPubKey.addresses[0].includes(payment.address))
            ) {
              emitData.vout = vout.n;
              payment.vout = emitData.vout;
            }
          }
        }
        emitData.id = payment.id;
        emitData.amount = payment.amount;
        emitData.address = payment.address;
        payment.txid = emitData.txid;
        if (emitData.error) {
          this.emitter.emit('failure', emitData);
          payment.error = emitData.error;
        } else {
          this.emitter.emit('success', emitData);
        }
        payToArrayResult.push(payment);
      }
    }
    await this.walletLock();
    this.emitter.emit('done');
    return payToArrayResult;
  }

  async getWalletInfo() {
    return this.asyncCall('getWalletInfo', []);
  }

  async isWalletEncrypted() {
    const walletInfo = await this.getWalletInfo();
    return walletInfo.hasOwnProperty('unlocked_until');
  }

  async isWalletLocked() {
    const walletInfo = await this.getWalletInfo();
    return walletInfo['unlocked_until'] === 0;
  }

  async walletUnlock({ passphrase, time }) {
    if (await this.isWalletEncrypted()){
      await this.asyncCall('walletPassPhrase', [passphrase, time]);
    }
    this.emitter.emit('unlocked', time );
  }

  async walletLock() {
    if (await this.isWalletEncrypted()){
      await this.asyncCall('walletLock', []);
    }
    this.emitter.emit('locked');
  }

  async estimateFee({ nBlocks, mode }) {
    const args = [nBlocks];
    if (mode) { // We don't want args[1] to be undefined/null
      args.push(mode);
    }
    const { feerate: feeRate } = await this.asyncCall('estimateSmartFee', args);
    const satoshisPerKb = Math.round(feeRate * 1e8);
    const satoshisPerByte = satoshisPerKb / 1e3;
    return satoshisPerByte;
  }

  async getBalance() {
    const balanceInfo = await this.asyncCall('getWalletInfo', []);
    return balanceInfo.balance * 1e8;
  }

  async getBestBlockHash() {
    return this.asyncCall('getBestBlockHash', []);
  }

  async getTransaction({ txid, detail = false }) {
    const tx = await this.getRawTransaction({ txid });

    if (tx && detail) {
      for (let input of tx.vin) {
        const prevTx = await this.getTransaction({ txid: input.txid });
        const utxo = prevTx.vout[input.vout];
        const { value } = utxo;
        const address = utxo.scriptPubKey.address ||
          // Legacy  
          (utxo.scriptPubKey.addresses && utxo.scriptPubKey.addresses.length && utxo.scriptPubKey.addresses[0]);
        input = Object.assign(input, {
          value,
          address,
          confirmations: prevTx.confirmations
        });
      }
      tx.unconfirmedInputs = tx.vin.some(input => !input.confirmations || input.confirmations < 1);
      let totalInputValue = tx.vin.reduce(
        (total, input) => total + input.value * 1e8,
        0
      );
      let totalOutputValue = tx.vout.reduce(
        (total, output) => total + output.value * 1e8,
        0
      );
      tx.fee = totalInputValue - totalOutputValue;
    }

    return tx;
  }

  async getRawTransaction({ txid }) {
    try {
      return await this.asyncCall('getRawTransaction', [txid, 1]);
    } catch (err) {
      if (err.code === -5) {
        return null;
      }
      throw err;
    }
  }

  async sendRawTransaction({ rawTx }) {
    return this.asyncCall('sendRawTransaction', [rawTx]);
  }

  async decodeRawTransaction({ rawTx }) {
    return this.asyncCall('decodeRawTransaction', [rawTx]);
  }

  async getBlock({ hash, verbose = 1 }) {
    return this.asyncCall('getBlock', [hash, verbose]);
  }

  async getBlockHash({ height }) {
    return this.asyncCall('getBlockHash', [height]);
  }

  async getConfirmations({ txid }) {
    const tx = await this.getTransaction({ txid });
    if (!tx) {
      return null;
    }
    if (tx.blockhash === undefined) {
      return 0;
    }
    return tx.confirmations;
  }

  async getTip() {
    const blockchainInfo = await this.asyncCall('getblockchaininfo', []);
    const { blocks: height, bestblockhash: hash } = blockchainInfo;
    return { height, hash };
  }

  async getTxOutputInfo({ txid, vout, includeMempool = false, transformToBitcore }) {
    const txidInfo = await this.asyncCall('gettxout', [txid, vout, includeMempool]);
    if (!txidInfo) {
      this.emitter.emit('error', new Error(`No info found for ${txid}`));
      return null;
    }
    if (transformToBitcore) {
      let bitcoreUtxo = {
        mintIndex: vout,
        mintTxid: txid,
        address: txidInfo.scriptPubKey.address || txidInfo.scriptPubKey.addresses[0], // Legacy
        script: txidInfo.scriptPubKey.hex,
        value: txidInfo.value,
        confirmations: txidInfo.confirmations
      };
      return bitcoreUtxo;
    }
    return txidInfo;
  }

  async validateAddress({ address }) {
    const validateInfo = await this.asyncCall('validateaddress', [address]);
    const { isvalid } = validateInfo;
    return isvalid;
  }

  getAccountInfo() {
    return {};
  }
}

module.exports = BtcRpc;
