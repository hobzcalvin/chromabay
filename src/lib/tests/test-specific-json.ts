import { deserializePattern } from '../patternSerializer';

const testJson = `{"nodes":[{"t":"rainbow","o":0},{"t":"perlin_noise","o":1},{"t":"moving_blob","o":2,"i":0},{"t":"raindrops","o":1,"i":0},{"t":"blend","o":2,"i":1,"i2":1},{"t":"blend","o":0,"i":2,"i2":2}],"meta":{"output":0}}`;

try {
  const parsed = JSON.parse(testJson);
  console.log('Input JSON:', JSON.stringify(parsed, null, 2));
  
  const { nodes, edges, nodeParameters } = deserializePattern(parsed);
  
  console.log(`\nDeserialized: ${nodes.length} nodes, ${edges.length} edges`);
  
  nodes.forEach(node => {
    console.log(`Node: ${node.data.type} at lane ${node.position.x === 25 ? 0 : node.position.x === 175 ? 1 : 2}, y=${node.position.y}`);
  });
  
  console.log('\nEdges:');
  edges.forEach(edge => {
    const sourceNode = nodes.find(n => n.id === edge.source);
    const targetNode = nodes.find(n => n.id === edge.target);
    console.log(`${sourceNode?.data.type} -> ${targetNode?.data.type} (${edge.targetHandle})`);
  });
  
} catch (error) {
  console.error('Error:', error);
}
