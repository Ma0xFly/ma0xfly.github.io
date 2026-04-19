export const tagMeta: Record<string, string> = {
  "合约审计": "系统性审查智能合约的逻辑漏洞与安全隐患。",
  "漏洞分析": "剖析历史攻击事件背后的深层代码缺陷与机制失效。",
  "协议机制": "拆解头部 Web3 协议的运行逻辑与经济学模型。",
  "面试": "涵盖技术领域从概念夯实到工程实战的经典问题。",
  "区块链技术原理": "深入探讨分布式账本、共识算法与底层密码学。",
  "DeFi": "涉及去中心化金融的乐高拼跳与资产应用。",
  "Solidity": "智能合约开发底层的语法精粹与安全最佳实践。"
};

export function getTagDescription(tag: string): string {
  // 如果精准匹配
  if (tagMeta[tag]) return tagMeta[tag];
  
  // 模糊匹配包含在字典里的词
  for (const [key, desc] of Object.entries(tagMeta)) {
    if (tag.toLowerCase().includes(key.toLowerCase())) {
      return desc;
    }
  }

  // 默认兜底
  return "该主题下的相关随笔与知识归档。";
}
