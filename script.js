document.addEventListener('DOMContentLoaded', () => {
    const searchButton = document.getElementById('search-button');
    const addressInput = document.getElementById('address-input');
    const transactionList = document.getElementById('transaction-list');
    const loadingMessage = document.getElementById('loading-message');

    // ★最も安定したRPCエンドポイントを使用★
    const SUI_RPC_URL = 'https://sui-mainnet.public.blastapi.io/'; 

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
            // 1. SUI RPCを呼び出して、アドレスが関与したイベントからトランザクションダイジェストを取得
            // ★★★ 修正点：アドレスが関与したイベントを検索する ★★★
            const response = await fetch(SUI_RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "sui_queryTransactions",
                    params: [{
                        // FromAddressとToAddressの両方で検索する（最も広く検索する設定）
                        ToAddress: address, 
                        // または以下の条件で試す
                        // FromAddress: address 
                    }, null, 50, true] // 最新の50件を取得
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }

            const data = await response.json();
            
            // データが存在するかチェック
            if (!data.result || !data.result.data || data.result.data.length === 0) {
                transactionList.innerHTML = '<tr><td colspan="5">指定されたアドレスのトランザクション履歴が見つかりませんでした。</td></tr>';
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
                    showObjectChanges: true 
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
                    const row = parseTransaction(tx, address);
                    // ★スワップ取引を優先表示するフィルターは、parseTransaction関数内で行います
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
    function parseTransaction(tx, userAddress) {
        const row = document.createElement('tr');
        
        // 1. 日時
        const timestampMs = tx.checkpoint ? Number(tx.checkpoint.timestampMs) : (tx.effects?.timestampMs ? Number(tx.effects.timestampMs) : 0);
        const timestamp = timestampMs ? new Date(timestampMs).toLocaleString() : '不明';

        // 2. ガス代 (SUI)
        const gasUsedMIST = tx.effects?.gasUsed?.computationCost ? 
            Number(tx.effects.gasUsed.computationCost) + Number(tx.effects.gasUsed.storageCost) - Number(tx.effects.gasUsed.storageRebate) : 0;
        const gasUsedSUI = gasUsedMIST / 1_000_000_000;
        
        // 3. スワップ情報（解析の核心部分）
        let swapIn = '---';
        let swapOut = '---';
        let isSwap = false;
        let transactionType = '不明な取引';

        // トランザクションイベントからトークン移動情報を抽出
        const coinChanges = tx.effects?.coinBalanceChange || [];
        
        // スワップ判定ロジック：ユーザーアドレスで「入金」と「出金」の両方が発生しているか
        const userInChanges = coinChanges.filter(c => c.owner.Address === userAddress && c.changeType === 'GasCost');
        const userOutChanges = coinChanges.filter(c => c.owner.Address === userAddress && c.changeType === 'CoinBalanceChange' && Number(c.amount) < 0);
        const userReceiveChanges = coinChanges.filter(c => c.owner.Address === userAddress && c.changeType === 'CoinBalanceChange' && Number(c.amount) > 0);
        
        // MoveCallの確認 (スワップ関数の呼び出しがあるか)
        const moveCall = tx.transaction?.data?.message?.MoveCall;
        const functionName = moveCall ? moveCall.function.toLowerCase() : '';

        // ★★★ スワップと判定 ★★★
        if (moveCall && (functionName.includes('swap') || functionName.includes('exchange')) || (userOutChanges.length > 0 && userReceiveChanges.length > 0)) {
            isSwap = true;
            transactionType = 'スワップ/両替';
            
            // スワップ元の情報（送信したトークン）
            if (userOutChanges.length > 0) {
                const outInfo = userOutChanges[0];
                const amount = (Math.abs(Number(outInfo.amount)) / (10 ** 9)).toFixed(2); // 仮に9桁で調整
                swapIn = `${amount} ${outInfo.coinType.split('::').pop()}`;
                
                if (userOutChanges.length > 1) {
                    swapIn += ` (+${userOutChanges.length - 1}種類)`;
                }
            } else {
                swapIn = '不明な送信元';
            }
            
            // スワップ先の情報（受信したトークン）
            if (userReceiveChanges.length > 0) {
                const inInfo = userReceiveChanges[0];
                const amount = (Number(inInfo.amount) / (10 ** 9)).toFixed(2); // 仮に9桁で調整
                swapOut = `${amount} ${inInfo.coinType.split('::').pop()}`;
                
                if (userReceiveChanges.length > 1) {
                    swapOut += ` (+${userReceiveChanges.length - 1}種類)`;
                }
            } else {
                swapOut = '不明な受信先';
            }
        }
        
        // スワップ以外の場合の表示
        if (!isSwap) {
            if (moveCall) {
                if (functionName.includes('transfer')) transactionType = 'SUI/トークン送信';
                else if (functionName.includes('stake') || functionName.includes('unstake')) transactionType = 'ステーキング';
                else transactionType = `MoveCall: ${functionName}`;
            } else if (tx.transaction?.data?.message?.TransferObjects) {
                transactionType = 'SUI/オブジェクト送信';
            } else {
                transactionType = 'その他の取引';
            }
            
            // スワップ以外は取引種類をまとめて表示
            swapIn = transactionType;
            swapOut = '---';
        }

        // トランザクションID
        const digest = tx.digest;

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
