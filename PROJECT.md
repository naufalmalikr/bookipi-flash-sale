# Take-Home Project: High-Throughput Flash Sale System

## Objective

The goal of this project is to assess your ability to design, implement, and test a robust, scalable, and high-throughput system. You will be building a simplified flash sale platform for a single product with limited stock. This exercise is designed to showcase your thought process in handling high-traffic scenarios, ensuring system stability, and making sound architectural decisions.

---

## Problem Description

Imagine you are tasked with building the backend system for a highly anticipated flash sale. A new, limited-edition product is launching, and thousands of users are expected to attempt to purchase it simultaneously. The sale will only be active for a specific period, and to ensure fairness, each user can only purchase one item.

Your mission is to design and build a system that can gracefully handle this sudden surge in traffic, manage inventory accurately, and provide a reliable user experience.

## Core Functional Requirements

1. **Flash Sale Period:** The flash sale must have a configurable start and end time. The system should only allow purchase attempts within this window.

2. **Single Product, Limited Stock:** To simplify the problem, we will only be selling one type of product. This product has a predefined, limited quantity available for purchase.

3. **One Item Per User:** Each user is permitted to purchase only one unit of the product during the sale. The system must enforce this rule.

4. **API Server:** You need to implement a server that exposes the necessary API endpoints to support the flash sale functionality. This should include, but is not limited to:
   - An endpoint to check the status of the flash sale (e.g., upcoming, active, ended).
   - An endpoint for a user to attempt a purchase.
   - An endpoint for a user to check if they have successfully secured an item.

5. **Simple Frontend:** Develop a basic frontend interface to demonstrate the functionality of your system. The frontend should allow a user to:
   - See the current status of the sale.
   - Enter a user identifier (e.g., a username or email).
   - Click a "Buy Now" button to attempt a purchase.
   - Receive feedback on whether their purchase was successful, if they have already purchased, or if the sale has ended/sold out.

6. **System Diagram:** Create a clear and concise system architecture diagram. This should illustrate the main components of your system and how they interact with each other. Be prepared to justify your design choices.

## Non-Functional Requirements

1. **High Throughput & Scalability:** The system must be designed to handle a large number of concurrent requests. Your design should be scalable to accommodate even larger traffic loads. Think about potential bottlenecks and how to mitigate them.

2. **Robustness & Fault Tolerance:** The system should be resilient to failures. Consider what might go wrong under heavy load (e.g., service crashes, network issues) and how your system would handle such scenarios.

3. **Concurrency Control:** A critical aspect of this project is managing concurrent requests to purchase a limited number of items. Your solution must prevent overselling and handle race conditions effectively.

## Testing Requirements

- **Unit & Integration Tests:** Include unit and integration tests for your service's business logic and API endpoints.

- **Stress Tests:** Implement stress tests to simulate a high volume of concurrent users attempting to purchase the item. The goal is to demonstrate that your system can handle the load without failing and that your concurrency controls are effective. You should be able to explain the results of your stress tests.

## Technical Guidelines

- **Language & Framework:**
  - **Language:** **JavaScript** or **TypeScript** is required.
  - **Backend:** Your API server must be built using **Node.js** with one of the following: **Express**, **Fastify**, **Nest.js**, **or the native `http` module**.
  - **Frontend:** The user interface must be built using **React**.

- **Cloud Services:** You are encouraged to design your system with modern cloud services in mind (e.g., message queues, distributed caches, databases). However, for the purpose of this project, you do not need to deploy to a live cloud environment. **You can mock out these more advanced services.** For example, instead of using a managed Redis or RabbitMQ service, you can run them locally in Docker containers or even simulate their behavior in-memory for some components, as long as you explain your architectural choices.

- **Deliverables:** Please provide the following:
  1. A link to your source code in a Git repository (e.g., GitHub, GitLab).
  2. A `README.md` file in your repository that includes:
     - A brief explanation of your design choices and trade-offs.
     - The system diagram you have created.
     - Clear instructions on how to build and run the project (server, frontend, and tests).
     - Instructions on how to run the stress tests and a summary of the expected outcome.

## What We Are Looking For

- **System Design:** Your ability to think about the problem from a high level, identify potential challenges, and design a scalable and resilient architecture. The clarity of your system diagram and the reasoning behind your component choices are key.
- **Code Quality:** Clean, well-structured, and maintainable code. We value clarity and simplicity.
- **Correctness:** The system should correctly implement the functional requirements, especially the "one item per user" and "limited stock" rules, even under heavy load.
- **Testing:** A thoughtful approach to testing that demonstrates the robustness of your solution. Your stress tests should be meaningful and effectively prove your system's capabilities.
- **Pragmatism:** Your ability to make sensible engineering trade-offs. Explaining *why* you chose a particular approach is as important as the implementation itself.

We look forward to seeing your solution. Good luck!