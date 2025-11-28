document.addEventListener('DOMContentLoaded', () => {
    const searchButton = document.getElementById('search-button');
    const addressInput = document.getElementById('address-input');
    const transactionList = document.getElementById('transaction-list');
    const loadingMessage = document.getElementById('loading-message');

    // ★★★ 変更点: SUI メインネットのRPCエンドポイントを使用 ★★★
    const SUI_RPC_URL = 'https://fullnode.mainnet.sui.io:443'; 

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
                        FromAddress: address
                    }, null, 50, true] // ★変更点: 最新の50件を取得
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }

            const data = await response.json();
            
            // ★★★ 修正点: データが存在するかチェックするロジックを強化 ★★★
            if (!data.result || !data.result.data || data.result.data.length === 0) {
                transactionList.innerHTML = '<tr><td colspan="5">指定されたアドレスのトランザクション履歴は見つかりませんでした。</td></tr>';
                return;
            }

            const digests = data.result.data.map(tx => tx.digest);

            // 2. 取得したダイジェスト（ID）を使って、各トランザクションの詳細を取得
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
                errorMessage = "Failed to fetch: ブラウザのセキュリティ設定により、ローカルファイルからのデータ取得がブロックされています。GitHub Pagesなどに公開して再度お試しください。";
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
        const timestampMs = tx.transaction?.data?.expiration?.Epoch? Number(tx.transaction.data.expiration.Epoch) * 1000 : 0;
        const timestamp = timestampMs ? new Date(timestampMs).toLocaleString() : '不明';

        // 2. ガス代 (SUI)
        const gasUsedMIST = tx.effects?.gasUsed?.computationCost ? 
            Number(tx.effects.gasUsed.computationCost) + Number(tx.effects.gasUsed.storageCost) - Number(tx.effects.gasUsed.storageRebate) : 0;
        const gasUsedSUI = gasUsedMIST / 1_000_000_000;
        
        // 3. スワップ情報（最も難しい部分：簡易的な解析）
        let swapIn = '---';
        let swapOut = '---';
        let isSwap = false;
        let transactionType = '不明な取引';

        // Move Callから取引の種類を推定
        if (tx.transaction?.data?.message?.MoveCall) {
            const moveCall = tx.transaction.data.message.MoveCall;
            const functionName = moveCall.function.toLowerCase();
            
            if (functionName.includes('swap') || functionName.includes('exchange')) {
                isSwap = true;
                transactionType = 'スワップ/両替';
                // より詳細な情報は、イベントやオブジェクト変更から取得する必要がありますが、
                // 簡易表示としてMove Callの情報を利用
                swapIn = `MoveCall: ${moveCall.module}::${moveCall.function}`;
                swapOut = `詳細は要確認`;
            } else if (functionName.includes('mint')) {
                transactionType = 'ミント';
            } else if (functionName.includes('transfer')) {
                transactionType = 'トークン移動';
            } else {
                transactionType = `MoveCall: ${functionName}`;
            }
        } else if (tx.transaction?.data?.message?.TransferObjects) {
            transactionType = 'SUI/オブジェクト送信';
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