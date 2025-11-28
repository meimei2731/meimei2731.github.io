document.addEventListener('DOMContentLoaded', () => {
    const searchButton = document.getElementById('search-button');
    const addressInput = document.getElementById('address-input');
    const transactionList = document.getElementById('transaction-list');
    const loadingMessage = document.getElementById('loading-message');

    // ★★★ 修正点1: 別のSUI メインネットのRPCエンドポイントを使用 ★★★
    // これにより、以前のエンドポイントでの応答の問題を回避できる可能性があります。
    const SUI_RPC_URL = 'https://sui-mainnet-rpc.allthatnode.com:8545'; 

    searchButton.addEventListener('click', fetchTransactions);

    async function fetchTransactions() {
        const address = addressInput.value.trim();
        if (!address) {
            alert("ウォレットアドレスを入力してください。");
            return;
        }

        // 読み込み中メッセージを表示し、表をクリア
        transactionList.innerHTML = '';
        loadingMessage.style.display = 'block';

        try {
            // 1. SUI RPCを呼び出して、アドレスに関連するトランザクションダイジェスト（ID）のリストを取得
            const response = await fetch(SUI_RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "sui_queryTransactions",
                    params: [{
                        // ★修正点2: ToAddressに変更して、より包括的な取引を検索★
                        // FromAddressだけでなく、受信した取引も検索対象に含める
                        ToAddress: address 
                    }, null, 50, true] // 最新の50件を取得
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }

            const data = await response.json();
            
            // データが存在するかチェックするロジックを強化
            if (!data.result || !data.result.data || data.result.data.length === 0) {
                transactionList.innerHTML = '<tr><td colspan="5">指定されたアドレスのトランザクション履歴は見つかりませんでした。（別のアドレスで再試行してください）</td></tr>';
                return;
            }

            const digests = data.result.data.map(tx => tx.digest);

            // 2. 取得したダイジェスト（ID）を使って、各トランザクションの詳細を取得
            // 複数のリクエストを一度に送る（Batch Request）
            const detailRequests = digests.map(digest => ({
                jsonrpc: "2.0",
                id: digests.indexOf(digest) + 2,
                method: "sui_getTransactionBlock",
                params: [digest, {
                    showInput: true,
                    showEffects: true,
                    showEvents: true,
                    showObjectChanges: true // 詳細なオブジェクト変更情報も取得
                }]
            }));

            const detailResponse = await fetch(SUI_RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(detailRequests)
            });

            if (!detailResponse.ok) {
                throw new Error(`Detail Fetch Error: ${detailResponse.status}`);
            }

            const detailData = await detailResponse.json();
            
            // 3. データを解析して表に追加
            detailData.forEach(res => {
                // Batch Requestの応答形式は配列なので、各要素の結果をチェック
                if (res.result) {
                    const tx = res.result;
                    const row = parseTransaction(tx);
                    transactionList.appendChild(row);
                }
            });

        } catch (error) {
            console.error("トランザクション取得エラー:", error);
            let errorMessage = error.message;
            if (errorMessage.includes("Failed to fetch")) {
                errorMessage = "Failed to fetch: 接続エラーが発生しました。時間を置いて再試行してください。";
            }
            transactionList.innerHTML = `<tr><td colspan="5">データ取得中にエラーが発生しました: ${errorMessage}</td></tr>`;
        } finally {
            loadingMessage.style.display = 'none'; // 読み込み中メッセージを非表示
        }
    }
    
    // トランザクションの詳細情報から必要なデータを抽出する関数
    function parseTransaction(tx) {
        const row = document.createElement('tr');
        
        // 1. 日時
        // SUI RPCは通常、エフェクトまたはチェックポイントにタイムスタンプを持つ
        const timestampMs = tx.checkpoint ? Number(tx.checkpoint.timestampMs) : (tx.effects?.timestampMs ? Number(tx.effects.timestampMs) : 0);
        const timestamp = timestampMs ? new Date(timestampMs).toLocaleString() : '不明';

        // 2. ガス代 (SUI)
        const gasUsedMIST = tx.effects?.gasUsed?.computationCost ? 
            Number(tx.effects.gasUsed.computationCost) + Number(tx.effects.gasUsed.storageCost) - Number(tx.effects.gasUsed.storageRebate) : 0;
        const gasUsedSUI = gasUsedMIST / 1_000_000_000;
        
        // 3. スワップ情報（簡易的な解析）
        let swapIn = '---';
        let swapOut = '---';
        let isSwap = false;
        let transactionType = '不明な取引';

        if (tx.transaction?.data?.message?.MoveCall) {
            const moveCall = tx.transaction.data.message.MoveCall;
            const functionName = moveCall.function.toLowerCase();
            
            if (functionName.includes('swap') || functionName.includes('exchange')) {
                isSwap = true;
                transactionType = 'スワップ/両替';
                swapIn = `MoveCall: ${moveCall.module}::${moveCall.function}`;
                swapOut = `詳細は要確認`;
            } else if (functionName.includes('transfer')) {
                transactionType = 'SUI/トークン送信';
            } else if (functionName.includes('stake') || functionName.includes('unstake')) {
                transactionType = 'ステーキング';
            } else {
                transactionType = `MoveCall: ${functionName}`;
            }
        } else if (tx.transaction?.data?.message?.TransferObjects) {
            transactionType = 'SUI/オブジェクト送信';
        } else if (tx.transaction?.data?.message?.PayAllSui) {
             transactionType = '全SUI支払い';
        }
        
        // トランザクションID
        const digest = tx.digest;

        // スワップと推定されない場合は、取引の種類を表示
        if (!isSwap) {
            swapIn = transactionType;
            swapOut = '---';
        }

        // 表の行にデータをセット
        row.innerHTML = `
            <td>${timestamp}</td>
            <td>${swapIn}</td>
            <td>${swapOut}</td>
            <td>${gasUsedSUI.toFixed(6)}</td>
            <td><a href="https://suiscan.xyz/mainnet/tx/${digest}" target="_blank">${digest.substring(0, 10)}...</a></td>
        `;
        
        return row;
    }
});
