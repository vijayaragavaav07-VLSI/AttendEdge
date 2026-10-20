`timescale 1ns/1ps
module tb_attendedge_top;
    localparam CPB = 16;
    reg clk=0, btnC=1, esp_rx=1; wire esp_tx; wire [15:0] led;
    attendedge_top #(.CLKS_PER_BIT(CPB), .CLK_HZ(2000)) dut(
        .clk(clk), .btnC(btnC), .esp_rx(esp_rx), .esp_tx(esp_tx), .led(led));
    always #5 clk=~clk;
    task send(input [7:0] b); integer i; begin
        esp_rx=0; repeat(CPB) @(posedge clk);
        for(i=0;i<8;i=i+1) begin esp_rx=b[i]; repeat(CPB) @(posedge clk); end
        esp_rx=1; repeat(CPB) @(posedge clk);
    end endtask
    initial begin
        repeat(5) @(posedge clk); btnC=0;
        repeat(50) @(posedge clk);
        send(8'd10);  repeat(600) @(posedge clk);   // recorded
        send(8'd10);  repeat(600) @(posedge clk);   // already present
        send(8'd200); repeat(600) @(posedge clk);   // invalid id
        $finish;
    end
endmodule