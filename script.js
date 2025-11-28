document.addEventListener('DOMContentLoaded', () => {
    const searchButton = document.getElementById('search-button');
    const addressInput = document.getElementById('address-input');
    const transactionList = document.getElementById('transaction-list');
    const loadingMessage = document.getElementById('loading-message');

    // ★最強の修正点: 複数の接続先を用意し、順番に試す仕組み★
    const RPC_ENDPOINTS = [
        'https://fullnode.mainnet.sui.io:443',       // 公式1
        'https://sui-mainnet.public.blastapi.io',    // 予備1
        'https://mainnet.sui.rpcpool.com',           // 予備2
        'https://sui-mainnet-rpc.allthatnode.com/full/json_rpc' // 予備3
    ];

    searchButton.addEventListener('click', startSearch);

    async function startSearch() {
        const address = addressInput.value.trim();
        if (!address) {
            alert("ウォレットアドレスを入力してください。");
            return;
        }

        // 表示をクリア
        transactionList.innerHTML = '';
        loadingMessage.style.display = 'block';
        loadingMessage.innerText = '最適なサーバーを探して接続中...';

        // 利用可能なサーバーを探してデータを取得
        let success = false;
        for (const rpcUrl of RPC_ENDPOINTS) {
            try {
                console.log(`Trying connection to: ${rpcUrl}`);
                await fetchTransactions(address, rpcUrl);
                success = true;
                break; // 成功したらループを抜ける
            } catch (e) {
                console.warn(`Failed with ${rpcUrl}:`, e);
                // 次のURLを試すのでここでのエラーは無視
            }
        }

        if (!success) {
            loadingMessage.style.display = 'none';
            transactionList.innerHTML = '<tr><td colspan="5" style="color:red; font-weight:bold;">すべてのサーバーへの接続に失敗しました。時間をおいて再試行するか、下記の「確実な方法（SuiScan）」をお試しください。</td></tr>';
        }
    }

    async function fetchTransactions(address, rpcUrl) {
        // 1. トランザクションIDリストの取得
        // FromAddress (送信) と ToAddress (受信) の両方はAPI制限で一度に取れないため、
        // 確実性の高い「FromAddress」と「InputObject」で広く検索をかけます
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "sui_queryTransactions",
                params: [{
                    FromAddress: address 
                }, null, 50, true] 
            })
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();

        if (!data.result || !data.result.data || data.result.data.length === 0) {
            loadingMessage.style.display = 'none';
            transactionList.innerHTML = '<tr><td colspan="5">履歴が見つかりませんでした。</td></tr>';
            return;
        }

        const digests = data.result.data.map(tx => tx.digest);

        // 2. 詳細データの取得
        const detailRequests = digests.map(digest => ({
            jsonrpc: "2.0",
            id: digests.indexOf(digest) + 2,
            method: "sui_getTransactionBlock",
            params: [digest, {
                showInput: true,
                showEffects: true,
                showEvents: true,
                showBalanceChanges: true // ★重要: 残高の変化を直接見る
            }]
        }));

        const detailResponse = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(detailRequests)
        });

        if (!detailResponse.ok) throw new Error(`Detail Error`);
        const detailData = await detailResponse.json();
        
        loadingMessage.style.display = 'none';

        // 3. データの解析と表示
        detailData.forEach(res => {
            if (res.result) {
                const row = parseTransaction(res.result, address);
                transactionList.appendChild(row);
            }
        });
    }
    
    // 詳細解析ロジック
    function parseTransaction(tx, userAddress) {
        const row = document.createElement('tr');
        
        // 日時
        const timestampMs = Number(tx.timestampMs || (tx.checkpoint ? tx.checkpoint.timestampMs : 0));
        const timestamp = timestampMs ? new Date(timestampMs).toLocaleString('ja-JP') : '不明';

        // ガス代
        const gasUsedMIST = tx.effects?.gasUsed?.computationCost ? 
            Number(tx.effects.gasUsed.computationCost) + Number(tx.effects.gasUsed.storageCost) - Number(tx.effects.gasUsed.storageRebate) : 0;
        const gasUsedSUI = (gasUsedMIST / 1_000_000_000).toFixed(6);
        
        // ★スワップ・移動の判定（BalanceChangesを使用）
        let swapIn = '';
        let swapOut = '';
        let type = 'その他';

        const changes = tx.balanceChanges || [];
        // 自分に関連する変動のみ抽出
        const myChanges = changes.filter(c => c.owner.AddressOwner === userAddress);

        // マイナス（出したコイン）とプラス（入ったコイン）を分ける
        const outgoing = myChanges.filter(c => Number(c.amount) < 0 && c.coinType !== '0x2::sui::SUI'); // ガス代以外の出金
        const incoming = myChanges.filter(c => Number(c.amount) > 0);
        const suiOut = myChanges.find(c => Number(c.amount) < 0 && c.coinType === '0x2::sui::SUI'); // SUIの出金（ガス含む）

        // 判定ロジック
        if (outgoing.length > 0 && incoming.length > 0) {
            type = '🔄 スワップ';
            swapOut = outgoing.map(c => `${formatAmount(c.amount, c.coinType)} ${getCoinName(c.coinType)}`).join('<br>');
            swapIn = incoming.map(c => `${formatAmount(c.amount, c.coinType)} ${getCoinName(c.coinType)}`).join('<br>');
        } else if (outgoing.length > 0) {
            type = '📤 送金';
            swapOut = outgoing.map(c => `${formatAmount(c.amount, c.coinType)} ${getCoinName(c.coinType)}`).join('<br>');
            swapIn = '---';
        } else if (incoming.length > 0) {
            type = '📥 受取';
            swapOut = '---';
            swapIn = incoming.map(c => `${formatAmount(c.amount, c.coinType)} ${getCoinName(c.coinType)}`).join('<br>');
        } else if (suiOut) {
             // SUIのみが減っている場合（ガス代のみ、またはSUI送金）
             if (Math.abs(Number(suiOut.amount)) > 1000000000) { // 1SUI以上なら送金とみなす簡易判定
                 type = '📤 SUI送金';
                 swapOut = `${formatAmount(suiOut.amount, suiOut.coinType)} SUI`;
             } else {
                 type = '契約実行'; // ガス代のみ消費
             }
        }

        const digest = tx.digest;
        
        row.innerHTML = `
            <td style="white-space: nowrap;">${timestamp}</td>
            <td style="color:red;">${swapOut || '---'}</td>
            <td style="color:green;">${swapIn || '---'}</td>
            <td>${gasUsedSUI}</td>
            <td><a href="https://suiscan.xyz/mainnet/tx/${digest}" target="_blank">確認</a></td>
        `;
        return row;
    }

    function getCoinName(type) {
        return type.split('::').pop();
    }

    function formatAmount(amount, type) {
        // 簡易的に9桁で割る（SUIや多くのコインは9桁）。
        // 正確な桁数はメタデータ取得が必要だが、簡易版として9桁固定。
        return (Math.abs(Number(amount)) / 1_000_000_000).toFixed(4);
    }
});
