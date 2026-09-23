# Technical Challenge: Conversation Analysis Agent

  ## Context

  You're building an agent that analyzes a dataset of customer support conversations between users and an AI assistant. The goal is to help a product team understand what's happening in their conversations at scale: what patterns exist, what's going wrong, what could be improved.

  ## The Problem

  We're providing a dataset with ~5,000 conversations from a customer support bot. Each conversation contains multiple messages between a user and an AI assistant.

  Your task is to build an interactive agent that can answer questions about this dataset. The agent should support multi-turn conversations, allowing follow-up questions that build on previous context (e.g., "Show me frustrated users" → "Now only the unresolved ones" → "What do they have in common?").

  The agent should handle different types of analysis:

  - **Open-ended questions**: "What are the most common reasons users contact support?"
  - **Classification**: "Categorize these conversations by topic" or "Which conversations ended with an unresolved issue?"
  - **Pattern detection**: "What patterns do you see in conversations where users get frustrated?"
  - **Problem identification**: "What are the main failure modes of the assistant?"

  ## Dataset Format

  The dataset is provided as a JSON file with the following structure:

  ```json
  {
    "conversations": [
      {
        "id": "conv_001",
        "messages": [
          {"role": "user", "content": "..."},
          {"role": "assistant", "content": "..."}
        ],
        "metadata": {
          "timestamp": "2024-01-15T10:30:00Z",
        }
      }
    ]
  }
```

##  Example Questions Your Agent Should Handle

  1. "Group conversations by the type of problem the user is trying to solve"
  2. "Find conversations where the assistant gave incorrect or misleading information"
  3. "What are the top 5 topics users ask about, and how well does the assistant handle each?"
  4. "Show me examples of conversations where the user had to repeat themselves" → "What went wrong in those cases?" → "How could the assistant have handled it better?"

  ## Requirements

  - Your solution must be designed to work with datasets of this size (~5,000 conversations) or larger
  - The agent must support multi-turn conversations with follow-up questions
  - You're free to use any language or framework
  - You decide how users interact with your agent and how information is presented. The clearer and more usable, the better.

  ## What We're Looking For

  - Quality of responses: Does the agent provide accurate, insightful answers?
  - Architecture: How did you approach the problem of analyzing conversations at scale?
  - Code quality: Is the code well-structured, readable, and maintainable?
  - Decision making: What trade-offs did you consider and why did you make the choices you made?

  ## Deliverables

  - Private GitHub repository with your solution
  - README explaining:
    - How to run your solution
    - Your architectural decisions and why you made them
    - What trade-offs you considered
    - What are the limitations of your approach
    - What you would do differently with 5,000,000 conversations

  ## Bonus Points

  We value product thinking beyond the core analytical requirements. Bonus points may be awarded for solutions that make the analysis more useful, trustworthy, or actionable for a real product team.

  ## Tools

  You can use any tools you want, including AI coding assistants. However, you should be able to explain and justify every part of your solution.
