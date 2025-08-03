// When the button is clicked, change the heading and show a thank-you message
document.addEventListener("DOMContentLoaded", () => {
    const button = document.querySelector("button");
    const heading = document.querySelector("h1");

    button.addEventListener("click", () => {
        heading.innerText = "You're ready to build voice agents!";
        alert("Thanks for joining MurfAI's 30 Days of Voice Agents!");
    });
});