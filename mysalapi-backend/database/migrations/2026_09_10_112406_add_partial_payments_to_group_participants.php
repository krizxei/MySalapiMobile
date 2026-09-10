<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('group_participants', function (Blueprint $table) {
            $table->decimal('amount_paid', 12, 2)->default(0)->after('share_amount');
        });

        Schema::create('group_participant_payments', function (Blueprint $table) {
            $table->id();
            $table->foreignId('group_participant_id')->constrained('group_participants')->onDelete('cascade');
            $table->decimal('amount', 12, 2);
            $table->date('payment_date');
            $table->string('payment_method')->nullable();
            $table->foreignId('recorded_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('group_participant_payments');
        Schema::table('group_participants', function (Blueprint $table) {
            $table->dropColumn('amount_paid');
        });
    }
};