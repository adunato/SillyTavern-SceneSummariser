const chatState = {
    snapshots: [
        {title: 'Scene #1', text: 'Summary 1 Text', description: 'Desc 1'},
        {title: 'Scene #2', text: 'Summary 2 Text', description: 'Desc 2'},
        {title: 'Scene #3', text: 'Summary 3 Text', description: 'Desc 3'}
    ]
};

function testBuildSummary(count, fullCount) {
    let lastSnapshots = chatState.snapshots;
    
    if (count > 0) {
        lastSnapshots = chatState.snapshots.slice(-count);
    }
    
    console.log(`\n--- Testing Count: ${count}, Full Count: ${fullCount} ---`);
    console.log('lastSnapshots length:', lastSnapshots.length);
    
    const result = lastSnapshots.map((s, index) => {
        const isFull = fullCount === 0 || (lastSnapshots.length - index <= fullCount);
        console.log(`  Index ${index}: ${s.title} | isFull? ${isFull}`);
        return isFull ? `${s.title}: ${s.text}` : `${s.title}: ${s.description}`;
    }).join('\n');
    console.log('RESULT:\n' + result);
}

testBuildSummary(5, 0); // Expect all full
testBuildSummary(5, 1); // Expect 2 desc, 1 full
testBuildSummary(2, 1); // Expect 1 desc, 1 full
testBuildSummary(1, 0); // Expect 1 full
testBuildSummary(0, 0); // Expect all full
